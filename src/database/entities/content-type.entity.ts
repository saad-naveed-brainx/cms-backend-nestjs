import { Check, Column, Entity, ForeignKey, Unique } from 'typeorm';
import { TimestampedEntity } from './base.entity.js';
import { Site } from './site.entity.js';

/** The six field kinds. A seventh is a scope change (CLAUDE.md invariant 8). */
export const FIELD_KINDS = [
  'text',
  'richText',
  'image',
  'date',
  'boolean',
  'select',
] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

/**
 * One custom field on a content type. Its value lives at `content.data[key]`.
 * `key` never changes (renaming is unsupported); removing a field sets `hidden` and keeps the
 * stored values. Validated by the API with Zod on write (TYP-02), not by the database.
 */
export type FieldDefinition = {
  key: string;
  label: string;
  kind: FieldKind;
  required: boolean;
  hidden: boolean;
  /** Only for `select`. */
  options?: string[];
};

/**
 * A kind of content: Page, Post, or one an admin defines at runtime (Event, Cake). Defines the
 * custom fields its items carry and where they route.
 *
 * Page and Post are seeded for every site as built-in rows, so every content row has a type.
 */
@Entity('content_types')
@Unique(['siteId', 'slug'])
@Unique(['siteId', 'urlPrefix'])
@Unique(['siteId', 'id'])
@Check('content_types_slug_format_check', `"slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`)
@Check(
  'content_types_url_prefix_format_check',
  `"url_prefix" IS NULL OR "url_prefix" ~ '^(/[a-z0-9]+(-[a-z0-9]+)*)+$'`,
)
export class ContentType extends TimestampedEntity {
  @Column('uuid')
  @ForeignKey(() => Site, { onDelete: 'CASCADE' })
  siteId: string;

  /** Shown in the admin panel: "Event". */
  @Column('text')
  name: string;

  /** Internal key: "event". */
  @Column('text')
  slug: string;

  /**
   * Items route at `<url_prefix>/<slug>`: "/events" gives `/events/summer-gala`.
   * Null for Page, whose items route by the page tree instead.
   */
  @Column('text', { nullable: true })
  urlPrefix: string | null;

  @Column('jsonb', { default: () => "'[]'" })
  fields: FieldDefinition[];

  /** True only for Page: its items may have a parent (max depth 3, enforced by the API). */
  @Column('boolean', { default: false })
  hierarchical: boolean;

  /** Page and Post: seeded for every site and cannot be deleted. */
  @Column('boolean', { default: false })
  isBuiltin: boolean;

  @Column('boolean', { default: false })
  hasCategories: boolean;

  @Column('boolean', { default: false })
  hasTags: boolean;
}
