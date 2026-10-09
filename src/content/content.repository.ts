import { Injectable } from '@nestjs/common';
import { DataSource, IsNull, Not, QueryFailedError } from 'typeorm';
import { ContentStatus } from '../database/entities/content.entity.js';
import { Content } from '../database/entities/index.js';
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

/** What a list of pages can be narrowed by, and which slice of it to return. */
export type PageListOptions = {
  contentTypeId?: string;
  status?: ContentStatus;
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
 */
@Injectable()
export class ContentRepository extends ScopedRepository<Content, PageDefaults> {
  constructor(dataSource: DataSource) {
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
   * order), with how many pages match in all. Trashed pages are not in it.
   */
  list(
    siteId: string,
    { contentTypeId, status, limit, offset }: PageListOptions,
  ): Promise<{ rows: Content[]; total: number }> {
    return this.findPage(
      siteId,
      {
        ...(contentTypeId === undefined ? {} : { contentTypeId }),
        ...(status === undefined ? {} : { status }),
      },
      { order: { updatedAt: 'DESC', id: 'DESC' }, limit, offset },
    );
  }

  /** The base `create`, except that an address the site already uses is a `PathTakenError`. */
  override async create(
    siteId: string,
    data: NewRow<Content, PageDefaults>,
  ): Promise<Content> {
    try {
      return await super.create(siteId, data);
    } catch (error) {
      if (isPathTaken(error)) throw new PathTakenError(data.path, error);
      throw error;
    }
  }

  /**
   * The base `update` without the address fields: a patch carrying `slug`, `path` or `parentId`
   * is refused before anything is written, even when cast past the types. This check runs first,
   * then the base's own checks.
   */
  override async update(
    siteId: string,
    id: string,
    patch: PagePatch,
  ): Promise<Content | null> {
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
    return super.update(siteId, id, patch);
  }
}
