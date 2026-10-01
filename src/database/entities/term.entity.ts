import { Column, Entity, ForeignKey, Unique } from 'typeorm';
import { TimestampedEntity } from './base.entity.js';
import { Site } from './site.entity.js';

export enum Taxonomy {
  Category = 'category',
  Tag = 'tag',
}

/** A category or tag, per site (TAX-01). Which content types may use them is set on the type. */
@Entity('terms')
@Unique(['siteId', 'taxonomy', 'slug'])
@Unique(['siteId', 'id'])
export class Term extends TimestampedEntity {
  @Column('uuid')
  @ForeignKey(() => Site, { onDelete: 'CASCADE' })
  siteId: string;

  @Column({ type: 'enum', enum: Taxonomy, enumName: 'term_taxonomy' })
  taxonomy: Taxonomy;

  @Column('text')
  name: string;

  @Column('text')
  slug: string;

  /** Archive pages start hidden from search engines; overridable per term (TAX-02). */
  @Column('boolean', { default: true })
  noIndex: boolean;
}
