import { Injectable } from '@nestjs/common';
import { DataSource, IsNull, Not } from 'typeorm';
import { Content } from '../database/entities/index.js';
import { ScopedRepository, type Patch } from '../database/scoped.repository.js';

/**
 * A page's address. Changing any of these must recompute the `path` of every descendant in one
 * transaction (invariant 9), so they change only through dedicated methods (CNT-04/05/06),
 * never through `update` (plan D4).
 */
const ADDRESS_FIELDS = ['slug', 'path', 'parentId'] as const;
type AddressField = (typeof ADDRESS_FIELDS)[number];

/** A page update: any field except `id`, `siteId` and the address fields. */
export type PagePatch = Omit<Patch<Content>, AddressField> & {
  [K in AddressField]?: never;
};

/**
 * The pages desk: every page, post and custom-type item (`content`), one site at a time.
 * Trashed pages are hidden from every read except `findTrashed`.
 */
@Injectable()
export class ContentRepository extends ScopedRepository<
  Content,
  'status' | 'blocks' | 'data' | 'noIndex'
> {
  constructor(dataSource: DataSource) {
    super(dataSource, Content);
  }

  /** The site's page at this full public path (`/about/team`), or `null`. */
  findByPath(siteId: string, path: string): Promise<Content | null> {
    return this.findOneWhere(siteId, { path });
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
   * The base `update` without the address fields: a patch carrying `slug`, `path` or `parentId`
   * is refused before anything is written, even when cast past the types.
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
