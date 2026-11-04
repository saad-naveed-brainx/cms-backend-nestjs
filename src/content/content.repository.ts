import { Injectable } from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import {
  DataSource,
  IsNull,
  Not,
  QueryFailedError,
  type EntityManager,
  type Repository,
} from 'typeorm';
import { ContentStatus } from '../database/entities/content.entity.js';
import { Content, Revision } from '../database/entities/index.js';
import {
  ScopedRepository,
  type Forbidden,
  type NewRow,
  type Patch,
} from '../database/scoped.repository.js';

/**
 * A page's address. Changing any of these must recompute the `path` of every descendant in one
 * transaction (invariant 9), so they change only through dedicated methods (CNT-04/05/06),
 * never through `update` (plan D4).
 */
const ADDRESS_FIELDS = ['slug', 'path', 'parentId'] as const;
type AddressField = (typeof ADDRESS_FIELDS)[number];

/** A page update: any field except `id`, `siteId`, the system's dates and the address fields. */
export type PagePatch = Omit<Patch<Content>, AddressField> &
  Forbidden<AddressField>;

/** The columns a new page may leave to the database's defaults. */
type PageDefaults = 'status' | 'blocks' | 'data' | 'noIndex';

/**
 * The seven things a version holds: exactly what Save accepts (version-history plan D6). A change to
 * any of them makes a version; a change to anything else (the status, the publish time) does not.
 */
const VERSION_FIELDS = [
  'title',
  'blocks',
  'data',
  'seoTitle',
  'seoDescription',
  'canonicalUrl',
  'noIndex',
] as const;
type VersionField = (typeof VERSION_FIELDS)[number];

const isVersionField = (field: string): field is VersionField =>
  (VERSION_FIELDS as readonly string[]).includes(field);

/** A page's content as a version stores it. */
const snapshotOf = (
  page: Pick<Content, VersionField>,
): Record<VersionField, unknown> => ({
  title: page.title,
  blocks: page.blocks,
  data: page.data,
  seoTitle: page.seoTitle,
  seoDescription: page.seoDescription,
  canonicalUrl: page.canonicalUrl,
  noIndex: page.noIndex,
});

/**
 * Two values as JSON says them, so what the database holds and what a request carries compare equal
 * whatever the order of an object's keys or the class it was made from. Only for values that are
 * JSON all the way down (strings, numbers, booleans, `null`, dates, and the JSONB of `blocks` and
 * `data`), which is every field a save can change: a `Date` compares by its ISO text, and anything
 * JSON cannot say (a `bigint`, a `Buffer`, a `Map`, an `undefined` inside an object) would be
 * compared wrongly or throw, so a field of such a kind needs its own comparison, not this one.
 */
const plain = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value ?? null));
const same = (a: unknown, b: unknown): boolean =>
  isDeepStrictEqual(plain(a), plain(b));

/** TypeORM's own type for the values of an update, which the package root does not export. */
type UpdateValues = Parameters<Repository<Content>['update']>[1];

/** What a save did: the page as it is stored, and whether anything was written. */
export type PageSaved = { page: Content; changed: boolean };

/** What a list of pages can be narrowed by, and which slice of it to return. */
export type PageListOptions = {
  contentTypeId?: string;
  status?: ContentStatus;
  path?: string;
  limit: number;
  offset: number;
};

/**
 * Another page of the site already has this address. The table's unique rule on site and path
 * counts pages in the trash too, so a trashed page's address stays taken until it is deleted for good.
 */
export class PathTakenError extends Error {
  readonly path: string;

  /** `cause` is the database's own error, which names the rule that refused the write. */
  constructor(path: string, cause?: unknown) {
    super(`The address ${path} is already used by another page`, { cause });
    this.name = 'PathTakenError';
    this.path = path;
  }
}

/** Postgres' code for a unique violation, and the name the migration gives the address rule. */
const UNIQUE_VIOLATION = '23505';
const PATH_UNIQUE_CONSTRAINT = 'content_site_id_path_key';

function isPathTaken(error: unknown): boolean {
  if (!(error instanceof QueryFailedError)) return false;
  const { code, constraint } = error.driverError as {
    code?: string;
    constraint?: string;
  };
  return code === UNIQUE_VIOLATION && constraint === PATH_UNIQUE_CONSTRAINT;
}

/**
 * The pages desk: every page, post and custom-type item (`content`), one site at a time.
 * Trashed pages are hidden from every read except `findTrashed`.
 *
 * It also keeps a page's versions (version-history D-057 to D-060): making a page and saving a change
 * to what a version holds write the page and its version in one transaction, so there is never a
 * save without its version or a version of something that was not saved. Every write to a page goes
 * through this desk, so none can skip it; reading versions is the versions desk's job
 * (`revision.repository.ts`).
 */
@Injectable()
export class ContentRepository extends ScopedRepository<Content, PageDefaults> {
  constructor(private readonly dataSource: DataSource) {
    super(dataSource, Content);
  }

  /** The site's page at this full public path (`/about/team`), or `null`. */
  findByPath(siteId: string, path: string): Promise<Content | null> {
    return this.findOneWhere(siteId, { path });
  }

  /**
   * The site's published page at this path, or `null`. Drafts, pages waiting for review, scheduled
   * pages and trashed pages are not public, so they are `null` here, exactly like a path nobody
   * has used.
   */
  findPublishedByPath(siteId: string, path: string): Promise<Content | null> {
    return this.findOneWhere(siteId, {
      path,
      status: ContentStatus.Published,
    });
  }

  /**
   * The pages a visitor can reach from the top of the site: published, with no parent, of this
   * type, except the one at `exceptPath` (the home page). By title, at most `limit`.
   */
  async findPublishedTopLevel(
    siteId: string,
    contentTypeId: string,
    { exceptPath, limit }: { exceptPath: string; limit: number },
  ): Promise<Content[]> {
    const { rows } = await this.findPage(
      siteId,
      {
        contentTypeId,
        status: ContentStatus.Published,
        parentId: IsNull(),
        path: Not(exceptPath),
      },
      { order: { title: 'ASC', id: 'ASC' }, limit, offset: 0 },
    );
    return rows;
  }

  /**
   * One slice of a type's published items, newest first (by when they were published, ties by
   * id), with how many there are in all: what a visitor's blog page lists.
   */
  findPublishedOfType(
    siteId: string,
    contentTypeId: string,
    { limit, offset }: { limit: number; offset: number },
  ): Promise<{ rows: Content[]; total: number }> {
    return this.findPage(
      siteId,
      { contentTypeId, status: ContentStatus.Published },
      { order: { publishedAt: 'DESC', id: 'DESC' }, limit, offset },
    );
  }

  /** The site's trashed pages, oldest first. */
  findTrashed(siteId: string): Promise<Content[]> {
    return this.findAllWhere(
      siteId,
      { deletedAt: Not(IsNull()) },
      { withDeleted: true },
    );
  }

  /**
   * One slice of the site's pages, last changed first (ties by id, so every call gives the same
   * order), with how many pages match in all, and the id and name of each page's creator (keyed
   * by user id). Trashed pages are not in it.
   */
  async list(
    siteId: string,
    { contentTypeId, status, path, limit, offset }: PageListOptions,
  ): Promise<{
    rows: Content[];
    total: number;
    authors: Map<string, { id: string; name: string }>;
  }> {
    const { rows, total } = await this.findPage(
      siteId,
      {
        ...(contentTypeId === undefined ? {} : { contentTypeId }),
        ...(status === undefined ? {} : { status }),
        ...(path === undefined ? {} : { path }),
      },
      { order: { updatedAt: 'DESC', id: 'DESC' }, limit, offset },
    );
    const authors = await this.authorsOf(
      siteId,
      rows.map((row) => row.id),
    );
    return { rows, total, authors };
  }

  /**
   * The id and name of whoever created these pages of the site (plan D9 of users-roles). A join
   * from this site's own content to `users`, so it reaches only people who wrote here, including
   * people since removed from the site; never their email or password hash.
   */
  private async authorsOf(
    siteId: string,
    pageIds: string[],
  ): Promise<Map<string, { id: string; name: string }>> {
    if (pageIds.length === 0) return new Map();
    const found: { id: string; name: string }[] = await this.dataSource.query(
      `SELECT DISTINCT u.id, u.name
         FROM content c
         JOIN users u ON u.id = c.created_by
        WHERE c.site_id = $1 AND c.id = ANY($2::uuid[])`,
      [siteId, pageIds],
    );
    return new Map(found.map((author) => [author.id, author]));
  }

  /**
   * The base `create`, except that the page's first version is written in the same transaction, and
   * an address the site already uses is a `PathTakenError`. The version is dated when the page was
   * made and credited to its creator.
   */
  override async create(
    siteId: string,
    data: NewRow<Content, PageDefaults>,
  ): Promise<Content> {
    const row = this.newRow(siteId, data);
    try {
      return await this.dataSource.transaction(async (manager) => {
        const page = await manager.save(manager.create(Content, row));
        await this.writeVersion(manager, page, page.createdBy, page.createdAt);
        return page;
      });
    } catch (error) {
      if (isPathTaken(error)) throw new PathTakenError(data.path, error);
      throw error;
    }
  }

  /**
   * The base `update` without the address fields: a patch carrying `slug`, `path` or `parentId`
   * is refused before anything is written, even when cast past the types. A change to what a
   * version holds keeps its version, as `save` says; the answer is the page as stored.
   */
  override async update(
    siteId: string,
    id: string,
    patch: PagePatch,
  ): Promise<Content | null> {
    return (await this.save(siteId, id, patch))?.page ?? null;
  }

  /**
   * Saves changes to one of the site's pages, and says whether anything was written; `null` for an
   * unknown, malformed, trashed or other-site id. In one transaction (version-history D1 to D3):
   *
   * - the page's row is locked first, so two saves of one page queue up and the second starts from
   *   what the first left;
   * - values equal to the stored ones are not changes: a save that changes nothing writes nothing,
   *   not even who touched the page or when (`updatedBy` alone is not a change);
   * - a change to what a version holds (see `VERSION_FIELDS`) writes the new version after it. A
   *   page that has none yet first keeps the version it had, dated when it was last changed and
   *   credited to whoever changed it: nobody loses the text the first save replaces;
   * - a change to anything else (publishing, unpublishing) writes no version.
   *
   * A patch carrying `slug`, `path` or `parentId` is refused before anything is written, even when
   * cast past the types. The checks run in the order of the base: the address, the site id, the
   * system's dates, the id.
   */
  async save(
    siteId: string,
    id: string,
    patch: PagePatch,
  ): Promise<PageSaved | null> {
    const moved = ADDRESS_FIELDS.filter(
      (field) => (patch as Record<string, unknown>)[field] !== undefined,
    );
    if (moved.length > 0) {
      throw new Error(
        `A page's ${moved.join(', ')} cannot change through update: an address change needs ` +
          `the dedicated address operation (CNT-04/05/06), which also recomputes every ` +
          `descendant's path`,
      );
    }
    const changes = this.changesFor(siteId, id, patch);
    if (changes === null) return null;
    if (Object.keys(changes).length === 0) {
      const page = await this.findById(siteId, id);
      return page === null ? null : { page, changed: false };
    }

    return this.dataSource.transaction(async (manager) => {
      const pages = manager.getRepository(Content);
      const page = await pages.findOne({
        where: { siteId, id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!page) return null;

      // `updatedBy` says who made a change, so it is not a change of its own.
      const differing = Object.keys(changes).filter(
        (field) =>
          field !== 'updatedBy' &&
          !same(page[field as keyof Content], changes[field]),
      );
      if (differing.length === 0) return { page, changed: false };

      const makesVersion = differing.some(isVersionField);
      let newest = makesVersion
        ? await this.newestVersion(manager, siteId, id)
        : null;
      if (makesVersion && newest === null) {
        newest = await this.writeVersion(
          manager,
          page,
          page.updatedBy,
          page.updatedAt,
        );
      }

      // "Last changed" is the moment of the write: `now()` would be the start of this transaction,
      // which can be before a save that went first, since saves queue behind the row lock.
      await pages.update({ siteId, id }, {
        ...changes,
        updatedAt: () => 'clock_timestamp()',
      } as UpdateValues);
      const saved = await pages.findOneByOrFail({ siteId, id });

      if (makesVersion) {
        // Dated as the page was last changed, and always after the versions it already has, so the
        // newest is the last save even if two fall in one millisecond.
        const at =
          newest !== null && saved.updatedAt <= newest.createdAt
            ? new Date(newest.createdAt.getTime() + 1)
            : saved.updatedAt;
        await this.writeVersion(manager, saved, saved.updatedBy, at);
      }
      return { page: saved, changed: true };
    });
  }

  /** The page's newest version, or `null` when it has none. */
  private newestVersion(
    manager: EntityManager,
    siteId: string,
    contentId: string,
  ): Promise<Revision | null> {
    return manager.getRepository(Revision).findOne({
      where: { siteId, contentId },
      order: { createdAt: 'DESC', id: 'DESC' },
    });
  }

  /** Writes the page's content as one of its versions, saved by `by` at `at`. */
  private writeVersion(
    manager: EntityManager,
    page: Content,
    by: string | null,
    at: Date,
  ): Promise<Revision> {
    return manager.save(
      manager.create(Revision, {
        siteId: page.siteId,
        contentId: page.id,
        snapshot: snapshotOf(page),
        createdBy: by,
        createdAt: at,
      }),
    );
  }
}
