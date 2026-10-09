import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Site } from '../database/entities/index.js';

/** A change to a site's own row: its name, its whole theme, and settings to set (text) or drop (`null`). */
export type AppearanceChange = {
  name?: string;
  theme?: Record<string, unknown>;
  settings?: Record<string, string | null>;
};

/**
 * The site's own row (`sites`): its name, theme and settings, for the site that is asking. Every
 * method takes the `siteId` the request was checked for, so it can only ever reach that one row.
 * Addresses are the hostnames desk; creating a site is provisioning's (D-019).
 */
@Injectable()
export class SiteRepository {
  constructor(private readonly dataSource: DataSource) {}

  findById(siteId: string): Promise<Site | null> {
    return this.dataSource.getRepository(Site).findOneBy({ id: siteId });
  }

  /**
   * Applies the change in one transaction, the row locked, so two saves at once cannot lose each
   * other's settings; settings not named are kept. The site as it is now, or `null` if it is gone.
   */
  updateAppearance(
    siteId: string,
    change: AppearanceChange,
  ): Promise<Site | null> {
    return this.dataSource.transaction(async (manager) => {
      const sites = manager.getRepository(Site);
      const site = await sites.findOne({
        where: { id: siteId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!site) return null;

      const settings: Record<string, unknown> = { ...site.settings };
      for (const [key, value] of Object.entries(change.settings ?? {})) {
        if (value === null) delete settings[key];
        else settings[key] = value;
      }
      if (change.name !== undefined) site.name = change.name;
      if (change.theme !== undefined) site.theme = change.theme;
      site.settings = settings;
      await sites.save(site);
      return sites.findOneBy({ id: siteId });
    });
  }
}
