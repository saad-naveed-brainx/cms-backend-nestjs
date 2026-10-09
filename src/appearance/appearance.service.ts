import { Injectable, NotFoundException } from '@nestjs/common';
import type { Site } from '../database/entities/index.js';
import { SiteResolver } from '../sites/site-resolver.service.js';
import { WebsiteCache } from '../website/website-cache.service.js';
import type { AppearanceBody } from './appearance-input.js';
import { SiteRepository } from './site.repository.js';

/** What the Appearance screen reads and saves. `theme` is stored as is: `{}` for a new site. */
export type AppearanceView = {
  name: string;
  tagline: string;
  footerNote: string;
  theme: Record<string, unknown>;
};

const text = (value: unknown): string =>
  typeof value === 'string' ? value : '';

function toView(site: Site): AppearanceView {
  return {
    name: site.name,
    tagline: text(site.settings.tagline),
    footerNote: text(site.settings.footerNote),
    theme: site.theme,
  };
}

/**
 * A site's name, header tagline, footer note and theme (GOV-04), for the site the request was
 * checked for. A save shows on the website at once: the address lookup forgets the site, and the
 * website is told to forget its cached pages (CNT-08).
 */
@Injectable()
export class AppearanceService {
  constructor(
    private readonly sites: SiteRepository,
    private readonly resolver: SiteResolver,
    private readonly website: WebsiteCache,
  ) {}

  async get(siteId: string): Promise<AppearanceView> {
    const site = await this.sites.findById(siteId);
    if (!site) throw new NotFoundException('Site not found');
    return toView(site);
  }

  async update(siteId: string, body: AppearanceBody): Promise<AppearanceView> {
    const settings: Record<string, string | null> = {};
    if (body.tagline !== undefined) settings.tagline = body.tagline || null;
    if (body.footerNote !== undefined)
      settings.footerNote = body.footerNote || null;

    const site = await this.sites.updateAppearance(siteId, {
      name: body.name,
      theme: body.theme,
      settings,
    });
    if (!site) throw new NotFoundException('Site not found');

    this.resolver.invalidateSite(siteId);
    await this.website.forgetSite(siteId);
    return toView(site);
  }
}
