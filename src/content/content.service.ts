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
import type { Content, ContentType } from '../database/entities/index.js';
import type {
  CreatePageBody,
  ListQuery,
  UpdatePageBody,
} from './content-input.js';
import { ContentRepository, PathTakenError } from './content.repository.js';

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
  return { ...toSummary(page, types), blocks: page.blocks, data: page.data };
}

function toTypeView(type: ContentType) {
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
    private readonly types: ContentTypeRepository,
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

    const { rows, total } = await this.pages.list(siteId, {
      contentTypeId,
      status: query.status,
      limit: query.limit,
      offset: query.offset,
    });
    return {
      items: rows.map((page) => toSummary(page, types)),
      total,
      limit: query.limit,
      offset: query.offset,
    };
  }

  async get(siteId: string, id: string): Promise<PageView> {
    const page = await this.pages.findById(siteId, id);
    if (!page) throw new NotFoundException('Page not found');
    return toPage(page, await this.typesById(siteId));
  }

  /** A draft of the given type, owned by the person who made it. A taken address is a 409. */
  async create(
    access: SiteAccess,
    user: AuthUser,
    body: CreatePageBody,
  ): Promise<PageView> {
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
        blocks: body.blocks ?? [],
        data: body.data ?? {},
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
   * that is not there.
   */
  async update(
    access: SiteAccess,
    user: AuthUser,
    id: string,
    body: UpdatePageBody,
  ): Promise<PageView> {
    const page = await this.pages.findById(access.siteId, id);
    if (!page) throw new NotFoundException('Page not found');

    const mayEdit =
      access.permissions.includes(Permission.ContentEditAny) ||
      (access.permissions.includes(Permission.ContentEditOwn) &&
        page.createdBy === user.id);
    if (!mayEdit) throw new ForbiddenException();

    const updated = await this.pages.update(access.siteId, id, {
      ...body,
      updatedBy: user.id,
    });
    // Gone between the read and the write (trashed by someone else just now).
    if (!updated) throw new NotFoundException('Page not found');
    return toPage(updated, await this.typesById(access.siteId));
  }

  private async typesById(siteId: string): Promise<Map<string, ContentType>> {
    const types = await this.types.findMany(siteId);
    return new Map(types.map((type) => [type.id, type]));
  }
}
