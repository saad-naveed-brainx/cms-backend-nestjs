import {
  IsNull,
  type DataSource,
  type DeepPartial,
  type EntityTarget,
  type FindOptionsOrder,
  type FindOptionsWhere,
  type Repository,
} from 'typeorm';

/** What every site-owned row has. `createdAt` is there because lists are ordered by it. */
type SiteRow = { id: string; siteId: string; createdAt: Date };

/** `id` is assigned on insert and `siteId` comes from the argument: a caller sets neither. */
type ScopeKey = 'id' | 'siteId';

/**
 * Dates the system keeps: TypeORM sets `createdAt` and `updatedAt`, and the trash date belongs
 * to the trash operation (CNT-11). An update may not set them (UC-SR-56).
 */
type SystemKey = 'createdAt' | 'updatedAt' | 'deletedAt';

/** Refuses these keys even in a non-literal object, which excess-property checks miss. */
export type Forbidden<K extends PropertyKey> = { [P in K]?: never };

/**
 * A `findMany` filter. One object, never an OR-array: each branch of an OR would need its own
 * site condition. No `id` (that is `findById`) and no `siteId` (that is the first argument).
 */
export type Filter<E> = Omit<FindOptionsWhere<E>, ScopeKey> &
  Forbidden<ScopeKey>;

/** Properties whose type allows `null`: nullable columns, which a new row may leave out. */
type NullableKey<E> = {
  [K in keyof E]-?: null extends E[K] ? K : never;
}[keyof E];

/** What `create` may leave out: nullable and defaulted columns, and the timestamps TypeORM sets. */
type OptionalKey<E, Defaulted extends keyof E> = Exclude<
  NullableKey<E> | Defaulted | Extract<keyof E, 'createdAt' | 'updatedAt'>,
  ScopeKey
>;

/** `create` data: the row's fields except `id` and `siteId`, with the required ones required. */
export type NewRow<E, Defaulted extends keyof E = never> = Omit<
  E,
  ScopeKey | OptionalKey<E, Defaulted>
> &
  Partial<Pick<E, OptionalKey<E, Defaulted>>> &
  Forbidden<ScopeKey>;

/** An `update` patch: any of the row's fields except `id`, `siteId` and the system's dates. */
export type Patch<E> = Partial<Omit<E, ScopeKey | SystemKey>> &
  Forbidden<ScopeKey | SystemKey>;

/** TypeORM's `QueryDeepPartialEntity`, which the package root does not export. */
type UpdateValues<E extends SiteRow> = Parameters<Repository<E>['update']>[1];

/** Lists come back oldest first, ties broken by id, so every call gives the same order. */
const OLDEST_FIRST: FindOptionsOrder<SiteRow> = { createdAt: 'ASC', id: 'ASC' };

/**
 * A uuid in canonical form, of any version: rows the app writes have v7 ids, rows from
 * hand-written SQL get v4 from the database default. Postgres accepts every value this matches,
 * so nothing that passes it can fail with 22P02 (invalid input syntax for type uuid).
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/**
 * Refuses a missing or malformed site id before any SQL is sent, with one clear message.
 * TypeORM 1.x already throws its own error for `undefined` or `null` in a filter, but `''` and
 * `'abc'` would reach Postgres. This also keeps protecting if that TypeORM option ever changes.
 *
 * Exported, with `isUuid`, for a desk whose own query is a join and so cannot start from
 * `findOneWhere` (the members desk's `findAccess`): it makes the same checks first.
 */
export function requireSiteId(siteId: unknown): asserts siteId is string {
  if (!isUuid(siteId)) {
    throw new Error(
      'Site id is required: every desk call names its site by uuid',
    );
  }
}

/**
 * A caller's fields without `id` and `siteId`, whatever the types said, and without `undefined`
 * values: those mean "not given", never "set to null".
 */
function writableFields(fields: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).filter(
      ([key, value]) => key !== 'id' && key !== 'siteId' && value !== undefined,
    ),
  );
}

/**
 * The base of every site-scoped desk, and the only way in to a tenant's rows (invariant 1,
 * docs/DECISIONS.md D-015).
 *
 * - Every method takes the site id first and merges it into the query last, so a `siteId`
 *   slipped into a filter, new data or a patch can neither widen a query nor move a row.
 * - A missing or malformed site id is refused before any SQL is sent.
 * - Another site's row is `null`, exactly like a row that does not exist.
 * - Trashed rows (entities with a `@DeleteDateColumn`) are hidden from every read and write here.
 * - An update cannot set the system's dates: the timestamps or the trash date (UC-SR-56).
 *
 * The TypeORM repository stays private, so a desk offers only scoped methods and nothing can
 * call an unscoped `find()` through it. No `delete` and no pagination, on purpose (plan D3):
 * trash and permanent delete come with CNT-11, list limits with CNT-01.
 *
 * `Defaulted` names the entity's columns that have a database default (`status`, `blocks`), so
 * `create` may leave them out. Nullable columns are optional without being listed.
 */
export abstract class ScopedRepository<
  E extends SiteRow,
  Defaulted extends keyof E = never,
> {
  private readonly repository: Repository<E>;

  protected constructor(dataSource: DataSource, entity: EntityTarget<E>) {
    this.repository = dataSource.getRepository(entity);
  }

  /** One of the site's rows, or `null` for an unknown, malformed, trashed or other-site id. */
  async findById(siteId: string, id: string): Promise<E | null> {
    requireSiteId(siteId);
    if (!isUuid(id)) return null;
    return this.findOneWhere(siteId, { id } as FindOptionsWhere<E>);
  }

  /** The site's rows matching `where` (all of them without it), oldest first. */
  async findMany(siteId: string, where?: Filter<E>): Promise<E[]> {
    return this.findAllWhere(siteId, (where ?? {}) as FindOptionsWhere<E>);
  }

  /** Saves a new row on the site. Its id is a fresh v7 from the entity's `@BeforeInsert`. */
  async create(siteId: string, data: NewRow<E, Defaulted>): Promise<E> {
    requireSiteId(siteId);
    const row = this.repository.create({
      ...writableFields(data),
      siteId,
    } as DeepPartial<E>);
    return this.repository.save(row);
  }

  /**
   * Changes the given fields of one of the site's rows and returns the row as stored. `null`,
   * with nothing written, for an unknown, malformed, trashed or other-site id. An empty patch
   * writes nothing, so `updatedAt` stays as it was.
   *
   * Checked before any SQL, in this order: the site id, then the system's dates (a patch setting
   * one is refused whole), then the id.
   */
  async update(siteId: string, id: string, patch: Patch<E>): Promise<E | null> {
    requireSiteId(siteId);
    this.refuseSystemFields(patch);
    if (!isUuid(id)) return null;
    const changes = writableFields(patch);
    if (Object.keys(changes).length === 0) return this.findById(siteId, id);

    // The site and trash conditions sit in the UPDATE itself: no gap between check and write.
    const { affected } = await this.repository.update(
      this.liveRow(siteId, id),
      changes as UpdateValues<E>,
    );
    return affected ? this.findById(siteId, id) : null;
  }

  /** For a desk's own lookups (by path, by slug): the site's row matching `where`, or `null`. */
  protected async findOneWhere(
    siteId: string,
    where: FindOptionsWhere<E>,
  ): Promise<E | null> {
    requireSiteId(siteId);
    return this.repository.findOne({ where: this.onSite(siteId, where) });
  }

  /** For a desk's own lists: the site's rows matching `where`, oldest first. */
  protected async findAllWhere(
    siteId: string,
    where: FindOptionsWhere<E>,
    { withDeleted = false }: { withDeleted?: boolean } = {},
  ): Promise<E[]> {
    requireSiteId(siteId);
    return this.repository.find({
      where: this.onSite(siteId, where),
      order: OLDEST_FIRST as FindOptionsOrder<E>,
      withDeleted,
    });
  }

  /** `where` on one site. `siteId` goes last, so one inside `where` is overwritten. */
  private onSite(
    siteId: string,
    where: FindOptionsWhere<E>,
  ): FindOptionsWhere<E> {
    return { ...where, siteId } as FindOptionsWhere<E>;
  }

  /** What a write targets: this id, on this site, and not in the trash. */
  private liveRow(siteId: string, id: string): FindOptionsWhere<E> {
    const where: Record<string, unknown> = { id };
    const trash = this.trashField();
    if (trash) where[trash] = IsNull();
    return this.onSite(siteId, where as FindOptionsWhere<E>);
  }

  /**
   * Refuses a patch that sets one of the system's dates: TypeORM keeps `createdAt` and
   * `updatedAt`, and only the trash operation (CNT-11) may set the trash date. Without this, an
   * update setting `deletedAt` would trash the row and then answer `null`, as if nothing changed.
   */
  private refuseSystemFields(patch: object): void {
    const trash = this.trashField();
    const managed = ['createdAt', 'updatedAt', ...(trash ? [trash] : [])];
    const touched = managed.filter(
      (field) => (patch as Record<string, unknown>)[field] !== undefined,
    );
    if (touched.length > 0) {
      throw new Error(
        `Update cannot set ${touched.join(', ')}: managed by the system. TypeORM keeps the ` +
          `timestamps, and trash gets its own operation (CNT-11)`,
      );
    }
  }

  /** The trash date's property (`deletedAt`), for entities that have a trash. */
  private trashField(): string | undefined {
    return this.repository.metadata.deleteDateColumn?.propertyName;
  }
}
