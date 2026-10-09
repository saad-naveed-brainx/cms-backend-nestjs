import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ContentTypeRepository } from '../content-types/content-type.repository.js';
import { ContentRepository } from '../content/content.repository.js';
import type { Content } from '../database/entities/index.js';
import { PreviewTokenService } from '../preview/preview-token.service.js';
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

/** How many items a blog page lists at a time. */
export const LISTING_PAGE_SIZE = 10;

/** The furthest a blog page can be asked to go, so a request cannot ask for an absurd offset. */
const MAX_LISTING_PAGE = 1000;

/** The site and its menu: what every answer to the website carries. Nothing internal (no ids). */
type SiteFrame = {
  site: {
    name: string;
    theme: Record<string, unknown>;
    settings: Record<string, unknown>;
  };
  host: string;
  canonicalHost: string;
  navigation: { title: string; path: string }[];
};

/** One page of one site: what the website draws at a page's address. */
export type PublicSiteView = SiteFrame & {
  kind: 'page';
  page: {
    title: string;
    path: string;
    seoTitle: string | null;
    seoDescription: string | null;
    /** The page's own choice of original address; `null` means its address on `canonicalHost`. */
    canonicalUrl: string | null;
    noIndex: boolean;
    publishedAt: Date | null;
    blocks: unknown[];
  };
};

/**
 * A type's published items, newest first, at the type's own address (`/blog` lists the posts):
 * the site's blog page. `page` counts from 1, `LISTING_PAGE_SIZE` at a time.
 */
export type PublicListingView = SiteFrame & {
  kind: 'listing';
  listing: {
    title: string;
    path: string;
    items: { title: string; path: string; publishedAt: Date | null }[];
    page: number;
    pageSize: number;
    total: number;
  };
};

/** A preview: the page as last saved, whatever its status, never indexed. */
export type PublicPreviewView = PublicSiteView & {
  preview: { status: string };
};

/** A type's name as a menu or a heading shows it: "Post" is "Posts" (until types carry a plural). */
function pluralOf(name: string): string {
  if (/s$/i.test(name)) return name;
  if (/[^aeiou]y$/i.test(name)) return `${name.slice(0, -1)}ies`;
  return `${name}s`;
}

/** The blog page asked for: 1 when not given; a whole number from 1 to 1000, or a 400. */
function parseListingPage(raw: unknown): number {
  if (raw === undefined) return 1;
  const page =
    typeof raw === 'string' && /^\d{1,4}$/.test(raw) ? Number(raw) : NaN;
  if (!(page >= 1 && page <= MAX_LISTING_PAGE)) {
    throw new BadRequestException('page must be a whole number from 1 to 1000');
  }
  return page;
}

/**
 * The public reading of a site (CNT-07): which site the address belongs to, and what is published
 * at a path: a page, or, at a type's own address with no page there, that type's blog page. Only
 * published items are ever returned, so every other state, and every other site's page, is the same
 * "not found" as a path nobody has used.
 */
@Injectable()
export class PublicSiteService {
  constructor(
    private readonly resolver: SiteResolver,
    private readonly pages: ContentRepository,
    private readonly types: ContentTypeRepository,
    private readonly previews: PreviewTokenService,
  ) {}

  async lookUp(
    rawHost: unknown,
    rawPath: unknown,
    rawPage?: unknown,
  ): Promise<PublicSiteView | PublicListingView> {
    // All are checked before any database call. The path goes first: it is the cheaper test.
    const path = parsePublicPath(rawPath);
    const listingPage = parseListingPage(rawPage);
    const resolved = await this.resolve(rawHost);
    const siteId = resolved.site.id;

    // A page someone made wins over a blog page at the same address.
    const page = await this.pages.findPublishedByPath(
      siteId,
      path === '/' ? HOME_PATH : path,
    );
    if (page) return this.view(resolved, page);

    const listed =
      path === '/' ? null : await this.types.findByUrlPrefix(siteId, path);
    if (!listed) throw new NotFoundException('Page not found');

    const { rows, total } = await this.pages.findPublishedOfType(
      siteId,
      listed.id,
      {
        limit: LISTING_PAGE_SIZE,
        offset: (listingPage - 1) * LISTING_PAGE_SIZE,
      },
    );
    // Page 1 of an empty blog is "nothing yet"; a page past the end is not there.
    if (rows.length === 0 && listingPage > 1) {
      throw new NotFoundException('Page not found');
    }
    return {
      kind: 'listing',
      ...(await this.frame(resolved)),
      listing: {
        title: pluralOf(listed.name),
        path,
        items: rows.map(({ title, path, publishedAt }) => ({
          title,
          path,
          publishedAt,
        })),
        page: listingPage,
        pageSize: LISTING_PAGE_SIZE,
        total,
      },
    };
  }

  /**
   * One page through a preview link (feature site-preview): the page the link names, as last
   * saved, published or not, but only at an address of the link's own site. A link that is
   * malformed, tampered with or out of date is a 401; a good link used at another site's address,
   * or for a page that has since been trashed, is the same 404 as any missing page.
   */
  async preview(
    rawHost: unknown,
    rawToken: unknown,
  ): Promise<PublicPreviewView> {
    const link = await this.previews.verify(rawToken);
    if (!link) {
      throw new UnauthorizedException(
        'This preview link has expired or is not valid',
      );
    }
    const resolved = await this.resolve(rawHost);
    if (resolved.site.id !== link.siteId) {
      throw new NotFoundException('Page not found');
    }
    const page = await this.pages.findById(link.siteId, link.pageId);
    if (!page) throw new NotFoundException('Page not found');

    const view = await this.view(resolved, page);
    return {
      ...view,
      page: { ...view.page, noIndex: true },
      preview: { status: page.status },
    };
  }

  /** The answer for one page of a resolved site. */
  private async view(
    resolved: ResolvedHost,
    page: Content,
  ): Promise<PublicSiteView> {
    return {
      kind: 'page',
      ...(await this.frame(resolved)),
      page: {
        title: page.title,
        path: page.path,
        seoTitle: page.seoTitle,
        seoDescription: page.seoDescription,
        canonicalUrl: page.canonicalUrl,
        noIndex: page.noIndex,
        publishedAt: page.publishedAt,
        blocks: page.blocks,
      },
    };
  }

  /**
   * The site's name, look and menu. The menu is its published top-level pages (not home), by
   * title, then a link to each blog page that has something published (`Posts` at `/blog`), at
   * most eight links in all, the blog links kept.
   */
  private async frame(resolved: ResolvedHost): Promise<SiteFrame> {
    const siteId = resolved.site.id;
    const types = await this.types.findMany(siteId);

    const blogLinks: { title: string; path: string }[] = [];
    for (const type of types) {
      if (!type.urlPrefix) continue;
      const { total } = await this.pages.findPublishedOfType(siteId, type.id, {
        limit: 1,
        offset: 0,
      });
      if (total > 0)
        blogLinks.push({ title: pluralOf(type.name), path: type.urlPrefix });
    }
    blogLinks.sort((a, b) => a.title.localeCompare(b.title));

    const pageType = types.find((type) => type.slug === NAVIGATION_TYPE);
    const pageLimit = Math.max(0, NAVIGATION_LIMIT - blogLinks.length);
    const topPages =
      pageType && pageLimit > 0
        ? await this.pages.findPublishedTopLevel(siteId, pageType.id, {
            exceptPath: HOME_PATH,
            limit: pageLimit,
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
      navigation: [
        ...topPages.map(({ title, path }) => ({ title, path })),
        ...blogLinks,
      ],
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
