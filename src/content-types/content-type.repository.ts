import { Injectable } from '@nestjs/common';
import { DataSource, QueryFailedError } from 'typeorm';
import { ContentType } from '../database/entities/index.js';
import {
  ScopedRepository,
  type NewRow,
} from '../database/scoped.repository.js';

type TypeDefaults =
  'fields' | 'hierarchical' | 'isBuiltin' | 'hasCategories' | 'hasTags';

/** Postgres's code for a broken unique rule. */
const UNIQUE_VIOLATION = '23505';

/**
 * Another type of the site already has this key or this address: the table's unique rules on
 * `(site_id, slug)` and `(site_id, url_prefix)` refused it (two people creating at once).
 */
export class TypeTakenError extends Error {
  constructor(cause?: unknown) {
    super(
      'Another content type of this site already has this name or address',
      {
        cause,
      },
    );
    this.name = 'TypeTakenError';
  }
}

/** The page types desk: a site's content types (Page, Post, Event), one site at a time. */
@Injectable()
export class ContentTypeRepository extends ScopedRepository<
  ContentType,
  TypeDefaults
> {
  constructor(dataSource: DataSource) {
    super(dataSource, ContentType);
  }

  /** The site's page type with this internal key (`event`), or `null`. */
  findBySlug(siteId: string, slug: string): Promise<ContentType | null> {
    return this.findOneWhere(siteId, { slug });
  }

  /** The site's type whose items live under this address (`/blog` for Post), or `null`. */
  findByUrlPrefix(
    siteId: string,
    urlPrefix: string,
  ): Promise<ContentType | null> {
    return this.findOneWhere(siteId, { urlPrefix });
  }

  /** The base `create`, except that a key or address the site's types already use is a `TypeTakenError`. */
  override async create(
    siteId: string,
    data: NewRow<ContentType, TypeDefaults>,
  ): Promise<ContentType> {
    try {
      return await super.create(siteId, data);
    } catch (error) {
      if (
        error instanceof QueryFailedError &&
        (error.driverError as { code?: string }).code === UNIQUE_VIOLATION
      ) {
        throw new TypeTakenError(error);
      }
      throw error;
    }
  }
}
