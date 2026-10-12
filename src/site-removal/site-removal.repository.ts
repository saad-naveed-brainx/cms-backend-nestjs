import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  Hostname,
  Organization,
  Site,
  SiteMember,
} from '../database/entities/index.js';

/** What happened: the site is gone (with the addresses it had), or it was not this person's to delete. */
export type SiteRemoval =
  | { outcome: 'deleted'; hostnames: string[] }
  | { outcome: 'not-owner' }
  | { outcome: 'not-found' };

/**
 * The site removal desk: the THIRD unscoped desk, next to the platform desk (reads) and the
 * provisioning desk (creates), and the ONLY place that deletes a site (D-039).
 *
 * It exists because a site is deleted by someone who owns its organisation, who need not be one of
 * its members, so the request is not scoped to the site. One method, one transaction: the owner is
 * checked inside it, and the site's own row is deleted, which takes every row the site owns with it
 * (each site-owned table's `site_id` key is `ON DELETE CASCADE`).
 */
@Injectable()
export class SiteRemovalRepository {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Deletes the site if `userId` owns its organisation. The site's row is locked first, so a change
   * to it at the same moment waits. Someone who does not own it is `not-owner` when they are one of
   * its members (they know it exists) and `not-found` otherwise, like a site that is not there. The
   * addresses come back so the caller can tell the website to forget them: once the site is gone,
   * nothing else remembers them.
   */
  deleteOwnedSite(siteId: string, userId: string): Promise<SiteRemoval> {
    return this.dataSource.transaction(async (manager) => {
      const site = await manager.findOne(Site, {
        where: { id: siteId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!site) return { outcome: 'not-found' };

      const owned = await manager.existsBy(Organization, {
        id: site.organizationId,
        ownerId: userId,
      });
      if (!owned) {
        const member = await manager.existsBy(SiteMember, { siteId, userId });
        return { outcome: member ? 'not-owner' : 'not-found' };
      }

      const hostnames = (
        await manager.find(Hostname, {
          where: { siteId },
          order: { hostname: 'ASC' },
        })
      ).map((row) => row.hostname);
      await manager.delete(Site, { id: siteId });
      return { outcome: 'deleted', hostnames };
    });
  }
}
