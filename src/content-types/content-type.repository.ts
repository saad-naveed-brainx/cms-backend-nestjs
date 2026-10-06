import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ContentType } from '../database/entities/index.js';
import { ScopedRepository } from '../database/scoped.repository.js';

/** The page types desk: a site's content types (Page, Post, Event), one site at a time. */
@Injectable()
export class ContentTypeRepository extends ScopedRepository<
  ContentType,
  'fields' | 'hierarchical' | 'isBuiltin' | 'hasCategories' | 'hasTags'
> {
  constructor(dataSource: DataSource) {
    super(dataSource, ContentType);
  }

  /** The site's page type with this internal key (`event`), or `null`. */
  findBySlug(siteId: string, slug: string): Promise<ContentType | null> {
    return this.findOneWhere(siteId, { slug });
  }
}
