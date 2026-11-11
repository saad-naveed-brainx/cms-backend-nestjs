import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuthUser, SiteAccess } from '../auth/decorators.js';
import { Permission } from '../auth/permission.js';
import { ContentTypeRepository } from '../content-types/content-type.repository.js';
import { ContentStatus } from '../database/entities/content.entity.js';
import type {
  Content,
  ContentType,
  Revision,
} from '../database/entities/index.js';
import { PreviewTokenService } from '../preview/preview-token.service.js';
import { WebsiteCache } from '../website/website-cache.service.js';
import { cleanBlocks } from './clean-blocks.js';
import {
  type CreatePageBody,
  type ListQuery,
  type UpdatePageBody,
  type VersionsQuery,
} from './content-input.js';
import { ContentRepository, PathTakenError } from './content.repository.js';
import { RevisionRepository, type SaverRef } from './revision.repository.js';

/** A page's type as the screens need it. */
type TypeRef = { id: string; slug: string; name: string };

/** A page as a list shows it: no layout, no custom data. */
export type PageSummary = ReturnType<typeof toSummary>;

/** A page in full. */
export type PageView = ReturnType<typeof toPage>;

/** A content type, as `GET /content-types` lists it. */
export type ContentTypeView = ReturnType<typeof toTypeView>;

function typeRef(page: Content, types: Map<string, ContentType>): TypeRef {
  const type = types.get(page.contentTypeId);
  return {
    id: page.contentTypeId,
    slug: type?.slug ?? '',
    name: type?.name ?? '',
  };
}

/** Who created a page, as a list row shows it; `null` once their account is gone. */
export type AuthorRef = { id: string; name: string };

/** The page list's rows: each page with its author (plan D9). */
function toListRow(
  page: Content,
  types: Map<string, ContentType>,
  authors: Map<string, AuthorRef>,
) {
  return {
    ...toSummary(page, types),
    author:
      page.createdBy === null ? null : (authors.get(page.createdBy) ?? null),
  };
}

function toSummary(page: Content, types: Map<string, ContentType>) {
  return {
    id: page.id,
    type: typeRef(page, types),
    parentId: page.parentId,
    title: page.title,
    slug: page.slug,
    path: page.path,
    status: page.status,
    publishedAt: page.publishedAt,
    createdBy: page.createdBy,
    updatedBy: page.updatedBy,
    createdAt: page.createdAt,
    updatedAt: page.updatedAt,
  };
}

function toPage(page: Content, types: Map<string, ContentType>) {
  return {
    ...toSummary(page, types),
    blocks: page.blocks,
    data: page.data,
    seoTitle: page.seoTitle,
    seoDescription: page.seoDescription,
    canonicalUrl: page.canonicalUrl,
    noIndex: page.noIndex,
  };
}

export function toTypeView(type: ContentType) {
  return {
    id: type.id,
    slug: type.slug,
    name: type.name,
    urlPrefix: type.urlPrefix,
    hierarchical: type.hierarchical,
    hasCategories: type.hasCategories,
    hasTags: type.hasTags,
    isBuiltin: type.isBuiltin,
  };
}

/** A version in a list: when it was saved and by whom, no content. */
export type VersionRow = ReturnType<typeof toVersionRow>;

/** A version in full: what Save accepts, as it was at that save. */
export type VersionView = ReturnType<typeof toVersion>;

function toVersionRow(row: Revision, savers: Map<string, SaverRef>) {
  return {
    id: row.id,
    savedAt: row.createdAt,
    // `null` for a version saved by an account that is gone.
    savedBy:
      row.createdBy === null ? null : (savers.get(row.createdBy) ?? null),
  };
}

const textOrNull = (value: unknown): string | null =>
  typeof value === 'string' ? value : null;

/**
 * The seven things Save accepts, read out of the stored snapshot. A snapshot that lacks one (an
 * older shape) still answers all seven, with their empty values, so the screens never meet a hole.
 */
function toVersion(row: Revision, savers: Map<string, SaverRef>) {
  const snapshot = row.snapshot;
  const data = snapshot.data;
  return {
    ...toVersionRow(row, savers),
    title: typeof snapshot.title === 'string' ? snapshot.title : '',
    blocks: Array.isArray(snapshot.blocks)
      ? (snapshot.blocks as unknown[])
      : [],
    data:
      typeof data === 'object' && data !== null && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : {},
    seoTitle: textOrNull(snapshot.seoTitle),
    seoDescription: textOrNull(snapshot.seoDescription),
    canonicalUrl: textOrNull(snapshot.canonicalUrl),
    noIndex: snapshot.noIndex === true,
  };
}

/**
 * Editing, and so reading a page's versions: `content.edit_any` on any page of the site,
 * `content.edit_own` only on a page the person created; neither is a 403. Checked after the page
 * is found, so a page that is not there (or another site's, or in the trash) stays a 404.
 */
function requireEditRight(
  access: SiteAccess,
  user: AuthUser,
  page: Content,
): void {
  const mayEdit =
    access.permissions.includes(Permission.ContentEditAny) ||
    (access.permissions.includes(Permission.ContentEditOwn) &&
      page.createdBy === user.id);
  if (!mayEdit) throw new ForbiddenException();
}

/**
 * Publishing and unpublishing: `content.publish` on any page of the site, `content.publish_own`
 * only on a page the person created; neither is a 403. Checked after the page is found, so a page
 * that is not there (or another site's) stays a 404, as with editing.
 */
function requirePublishRight(
  access: SiteAccess,
  user: AuthUser,
  page: Content,
): void {
  const mayPublish =
    access.permissions.includes(Permission.ContentPublish) ||
    (access.permissions.includes(Permission.ContentPublishOwn) &&
      page.createdBy === user.id);
  if (!mayPublish) throw new ForbiddenException();
}

/** A type's URL prefix and a slug make the page's full address: `/blog` + `hello` → `/blog/hello`. */
function addressFor(urlPrefix: string | null, slug: string): string {
  return `${(urlPrefix ?? '').replace(/\/+$/, '')}/${slug}`;
}

/**
 * Pages for the admin (CNT-01): list, read, create and edit, for one site at a time. Everything
 * goes through the pages desk and the types desk, so every read and write names its site, and the
 * site comes from the checked request, never from a body (api rule 6).
 */
@Injectable()
export class ContentService {
  constructor(
    private readonly pages: ContentRepository,
    private readonly versions: RevisionRepository,
    private readonly types: ContentTypeRepository,
    private readonly previews: PreviewTokenService,
    private readonly website: WebsiteCache,
  ) {}

  async listTypes(siteId: string): Promise<{ items: ContentTypeView[] }> {
    const types = await this.types.findMany(siteId);
    return { items: types.map(toTypeView) };
  }

  async list(siteId: string, query: ListQuery) {
    const types = await this.typesById(siteId);
    const empty = {
      items: [],
      total: 0,
      limit: query.limit,
      offset: query.offset,
    };

    let contentTypeId: string | undefined;
    if (query.type !== undefined) {
      const wanted = [...types.values()].find(
        (type) => type.slug === query.type,
      );
      if (!wanted) return empty; // a type the site does not have has no pages
      contentTypeId = wanted.id;
    }

    const { rows, total, authors } = await this.pages.list(siteId, {
      contentTypeId,
      status: query.status,
      path: query.path,
      limit: query.limit,
      offset: query.offset,
    });
    return {
      items: rows.map((page) => toListRow(page, types, authors)),
      total,
      limit: query.limit,
      offset: query.offset,
    };
  }

  /**
   * A preview link for one page, whatever its status: what was last saved, for 30 minutes, at
   * this site's own addresses only. Any member may ask, as any member may read the page here.
   */
  async preview(
    siteId: string,
    id: string,
  ): Promise<{ token: string; expiresAt: string }> {
    const page = await this.pages.findById(siteId, id);
    if (!page) throw new NotFoundException('Page not found');
    const { token, expiresAt } = await this.previews.sign(siteId, page.id);
    return { token, expiresAt: expiresAt.toISOString() };
  }

  async get(siteId: string, id: string): Promise<PageView> {
    const page = await this.pages.findById(siteId, id);
    if (!page) throw new NotFoundException('Page not found');
    return toPage(page, await this.typesById(siteId));
  }

  /**
   * A page's versions, newest first, in slices (version-history T1, plan D4, D7). Whoever may edit
   * the page may read them: the rule of a save, checked after the page is found.
   */
  async listVersions(
    access: SiteAccess,
    user: AuthUser,
    id: string,
    query: VersionsQuery,
  ): Promise<{
    items: VersionRow[];
    total: number;
    limit: number;
    offset: number;
  }> {
    const page = await this.pages.findById(access.siteId, id);
    if (!page) throw new NotFoundException('Page not found');
    requireEditRight(access, user, page);

    const { rows, total, savers } = await this.versions.listForPage(
      access.siteId,
      page.id,
      query,
    );
    return {
      items: rows.map((row) => toVersionRow(row, savers)),
      total,
      limit: query.limit,
      offset: query.offset,
    };
  }

  /**
   * One version of a page in full. A page that is not there and a version that is not that page's
   * are told alike ("Version not found"), so a version id never says which of the two is wrong.
   */
  async getVersion(
    access: SiteAccess,
    user: AuthUser,
    id: string,
    versionId: string,
  ): Promise<VersionView> {
    const page = await this.pages.findById(access.siteId, id);
    if (!page) throw new NotFoundException('Version not found');
    requireEditRight(access, user, page);

    const found = await this.versions.findOfPage(
      access.siteId,
      page.id,
      versionId,
    );
    if (!found) throw new NotFoundException('Version not found');
    return toVersion(found.row, found.savers);
  }

  /**
   * A draft of the given type, owned by the person who made it, with its first version (written
   * with it by the pages desk). A taken address is a 409.
   */
  async create(
    access: SiteAccess,
    user: AuthUser,
    body: CreatePageBody,
  ): Promise<PageView> {
    const blocks = cleanBlocks(body.blocks ?? []);
    const type = await this.types.findBySlug(access.siteId, body.type);
    if (!type) {
      throw new BadRequestException({
        message: 'Invalid request',
        errors: [`type: this site has no content type "${body.type}"`],
      });
    }

    try {
      const page = await this.pages.create(access.siteId, {
        contentTypeId: type.id,
        parentId: null,
        title: body.title,
        slug: body.slug,
        path: addressFor(type.urlPrefix, body.slug),
        blocks,
        data: body.data ?? {},
        seoTitle: body.seoTitle ?? null,
        seoDescription: body.seoDescription ?? null,
        canonicalUrl: body.canonicalUrl ?? null,
        noIndex: body.noIndex ?? false,
        createdBy: user.id,
        updatedBy: user.id,
      });
      return toPage(page, await this.typesById(access.siteId));
    } catch (error) {
      if (error instanceof PathTakenError) {
        throw new ConflictException(error.message);
      }
      throw error;
    }
  }

  /**
   * `content.edit_any` edits any page of the site; `content.edit_own` only pages the person
   * created; neither is a 403. A page of another site, or in the trash, is a 404 like any page
   * that is not there. A save that changes something keeps its version (D-057); one that changes
   * nothing writes nothing and does not tell the website.
   */
  async update(
    access: SiteAccess,
    user: AuthUser,
    id: string,
    body: UpdatePageBody,
  ): Promise<PageView> {
    const page = await this.pages.findById(access.siteId, id);
    if (!page) throw new NotFoundException('Page not found');
    requireEditRight(access, user, page);

    const saved = await this.pages.save(access.siteId, id, {
      ...body,
      ...(body.blocks ? { blocks: cleanBlocks(body.blocks) } : {}),
      updatedBy: user.id,
    });
    // Gone between the read and the write (trashed by someone else just now).
    if (!saved) throw new NotFoundException('Page not found');
    // A live page changed: the website must stop showing what it remembers (CNT-08). A draft is not
    // public, and a save that changed nothing changed nothing there (version-history D3).
    if (saved.changed && saved.page.status === ContentStatus.Published) {
      await this.website.forgetSite(access.siteId);
    }
    return toPage(saved.page, await this.typesById(access.siteId));
  }

  /**
   * Makes the page live now. Anything not yet live (a draft, a page waiting for review, a
   * scheduled one) becomes `published`; publishing a published page changes nothing, so the first
   * publish time stays. Who may: see `requirePublishRight`.
   */
  async publish(
    access: SiteAccess,
    user: AuthUser,
    id: string,
  ): Promise<PageView> {
    const page = await this.pages.findById(access.siteId, id);
    if (!page) throw new NotFoundException('Page not found');
    requirePublishRight(access, user, page);
    if (page.status === ContentStatus.Published) {
      return toPage(page, await this.typesById(access.siteId));
    }

    const updated = await this.pages.update(access.siteId, id, {
      status: ContentStatus.Published,
      publishedAt: new Date(),
      updatedBy: user.id,
    });
    if (!updated) throw new NotFoundException('Page not found');
    // New on the site, and in its menu and blog page: the website forgets the whole site (CNT-08).
    await this.website.forgetSite(access.siteId);
    return toPage(updated, await this.typesById(access.siteId));
  }

  /**
   * Takes a published page back to `draft`. A page that is not published is a 409. Who may: see
   * `requirePublishRight`.
   */
  async unpublish(
    access: SiteAccess,
    user: AuthUser,
    id: string,
  ): Promise<PageView> {
    const page = await this.pages.findById(access.siteId, id);
    if (!page) throw new NotFoundException('Page not found');
    requirePublishRight(access, user, page);
    if (page.status !== ContentStatus.Published) {
      throw new ConflictException('This page is not published');
    }

    const updated = await this.pages.update(access.siteId, id, {
      status: ContentStatus.Draft,
      publishedAt: null,
      updatedBy: user.id,
    });
    if (!updated) throw new NotFoundException('Page not found');
    // Off the site, its menu and its blog page: the website forgets the whole site (CNT-08).
    await this.website.forgetSite(access.siteId);
    return toPage(updated, await this.typesById(access.siteId));
  }

  private async typesById(siteId: string): Promise<Map<string, ContentType>> {
    const types = await this.types.findMany(siteId);
    return new Map(types.map((type) => [type.id, type]));
  }
}
