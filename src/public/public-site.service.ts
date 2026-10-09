import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ContentTypeRepository } from '../content-types/content-type.repository.js';
import { ContentRepository } from '../content/content.repository.js';
import {
  InvalidHostError,
  SiteResolver,
  type ResolvedHost,
} from '../sites/site-resolver.service.js';
import { HOME_PATH, parsePublicPath } from './public-path.js';

/** The most links the site's top navigation carries. */
const NAVIGATION_LIMIT = 8;

/** The key of the type whose top-level pages make up the navigation (posts do not). */
const NAVIGATION_TYPE = 'page';

/**
 * What the public website needs to draw one page of one site, and nothing internal: no site id,
 * no page id, no user ids.
 */
export type PublicSiteView = {
  site: {
    name: string;
    theme: Record<string, unknown>;
    settings: Record<string, unknown>;
  };
  host: string;
  canonicalHost: string;
  page: {
    title: string;
    path: string;
    seoTitle: string | null;
    seoDescription: string | null;
    noIndex: boolean;
    publishedAt: Date | null;
    blocks: unknown[];
  };
  navigation: { title: string; path: string }[];
};

/**
 * The public reading of a site (CNT-07): which site the address belongs to, and its published page
 * at a path. Only published pages are ever returned, so every other state, and every other site's
 * page, is the same "not found" as a path nobody has used.
 */
@Injectable()
export class PublicSiteService {
  constructor(
    private readonly resolver: SiteResolver,
    private readonly pages: ContentRepository,
    private readonly types: ContentTypeRepository,
  ) {}

  async lookUp(rawHost: unknown, rawPath: unknown): Promise<PublicSiteView> {
    // Both are checked before any database call. The path goes first: it is the cheaper test.
    const path = parsePublicPath(rawPath);
    const resolved = await this.resolve(rawHost);
    const siteId = resolved.site.id;

    const page = await this.pages.findPublishedByPath(
      siteId,
      path === '/' ? HOME_PATH : path,
    );
    if (!page) throw new NotFoundException('Page not found');

    const pageType = await this.types.findBySlug(siteId, NAVIGATION_TYPE);
    const navigation = pageType
      ? await this.pages.findPublishedTopLevel(siteId, pageType.id, {
          exceptPath: HOME_PATH,
          limit: NAVIGATION_LIMIT,
        })
      : [];

    return {
      site: {
        name: resolved.site.name,
        theme: resolved.site.theme,
        settings: resolved.site.settings,
      },
      host: resolved.host,
      canonicalHost: resolved.canonicalHost,
      page: {
        title: page.title,
        path: page.path,
        seoTitle: page.seoTitle,
        seoDescription: page.seoDescription,
        noIndex: page.noIndex,
        publishedAt: page.publishedAt,
        blocks: page.blocks,
      },
      navigation: navigation.map(({ title, path }) => ({ title, path })),
    };
  }

  private async resolve(rawHost: unknown): Promise<ResolvedHost> {
    let resolved: ResolvedHost | null;
    try {
      resolved = await this.resolver.resolve(rawHost);
    } catch (error) {
      if (error instanceof InvalidHostError) {
        throw new BadRequestException('host must be a valid web address');
      }
      throw error;
    }
    if (!resolved)
      throw new NotFoundException('No site answers on this address');
    return resolved;
  }
}
