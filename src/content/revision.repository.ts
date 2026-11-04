import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Revision } from '../database/entities/index.js';
import {
  ScopedRepository,
  isUuid,
  requireSiteId,
} from '../database/scoped.repository.js';

/** Who saved a version, as the Versions screen shows it: an id and a name, never an email. */
export type SaverRef = { id: string; name: string };

/**
 * The versions desk (version-history T1, `docs/features/version-history/`): the earlier states of a
 * page, one site at a time. It only reads. The pages desk writes a version in the same step as the
 * save it belongs to (T2, plan D1), so nothing else touches the table.
 */
@Injectable()
export class RevisionRepository extends ScopedRepository<Revision> {
  constructor(private readonly dataSource: DataSource) {
    super(dataSource, Revision);
  }

  /**
   * One slice of a page's versions, newest first (ties by id, so every call gives the same order),
   * with how many there are in all and who saved each (keyed by user id).
   */
  async listForPage(
    siteId: string,
    contentId: string,
    { limit, offset }: { limit: number; offset: number },
  ): Promise<{
    rows: Revision[];
    total: number;
    savers: Map<string, SaverRef>;
  }> {
    const { rows, total } = await this.findPage(
      siteId,
      { contentId },
      { order: { createdAt: 'DESC', id: 'DESC' }, limit, offset },
    );
    return { rows, total, savers: await this.saversOf(siteId, rows) };
  }

  /**
   * One version of one page, with who saved it, or `null` for an unknown, malformed or another
   * page's version id: told apart from nothing, so a version never answers for the wrong page.
   */
  async findOfPage(
    siteId: string,
    contentId: string,
    versionId: string,
  ): Promise<{ row: Revision; savers: Map<string, SaverRef> } | null> {
    if (!isUuid(versionId)) return null;
    const row = await this.findOneWhere(siteId, { id: versionId, contentId });
    if (!row) return null;
    return { row, savers: await this.saversOf(siteId, [row]) };
  }

  /**
   * The id and name of whoever saved these versions of the site. A join from this site's own
   * versions to `users`, so it reaches only people who saved here, including people since removed
   * from the site; never their email or password hash. A version whose account is gone has no
   * saver, so it is not in the map.
   */
  private async saversOf(
    siteId: string,
    rows: Revision[],
  ): Promise<Map<string, SaverRef>> {
    requireSiteId(siteId);
    const versionIds = rows
      .filter((row) => row.createdBy !== null)
      .map((row) => row.id);
    if (versionIds.length === 0) return new Map();
    const found: SaverRef[] = await this.dataSource.query(
      `SELECT DISTINCT u.id, u.name
         FROM revisions r
         JOIN users u ON u.id = r.created_by
        WHERE r.site_id = $1 AND r.id = ANY($2::uuid[])`,
      [siteId, versionIds],
    );
    return new Map(found.map((saver) => [saver.id, saver]));
  }
}
