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

/** What happened to an empty organisation: it is gone, or why it is not. */
export type OrganizationRemoval =
  | { outcome: 'deleted' }
  | { outcome: 'has-websites' }
  | { outcome: 'not-found' };

/**
 * The site removal desk: the THIRD unscoped desk, next to the platform desk (reads) and the
 * provisioning desk (creates), and the ONLY place that deletes a site (D-039), and an organisation
 * that has none (organizations T4).
 *
 * It exists because a site is deleted by someone who owns its organisation, who need not be one of
 * its members, so the request is not scoped to the site. Each method is one transaction with the
 * owner checked inside it. A site's own row is deleted, which takes every row the site owns with it
 * (each site-owned table's `site_id` key is `ON DELETE CASCADE`). An organisation is deleted only
 * when it has no website, so no website data can go with it.
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

  /**
   * Deletes the organisation if `userId` owns it and it has no website. Its row is locked first, so a
   * website being added to it at the same moment waits and then finds it gone. One with a website is
   * never deleted; someone else's, and one that is not there, are `not-found`.
   */
  deleteEmptyOrganization(
    organizationId: string,
    userId: string,
  ): Promise<OrganizationRemoval> {
    return this.dataSource.transaction(async (manager) => {
      const organization = await manager.findOne(Organization, {
        where: { id: organizationId, ownerId: userId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!organization) return { outcome: 'not-found' };
      if (await manager.existsBy(Site, { organizationId })) {
        return { outcome: 'has-websites' };
      }
      await manager.delete(Organization, { id: organizationId });
      return { outcome: 'deleted' };
    });
  }
}
