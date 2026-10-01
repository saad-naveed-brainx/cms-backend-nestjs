import {
  Check,
  Column,
  DeleteDateColumn,
  Entity,
  ForeignKey,
  Index,
  Unique,
} from 'typeorm';
import { TimestampedEntity } from './base.entity.js';
import { ContentType } from './content-type.entity.js';
import { Media } from './media.entity.js';
import { Site } from './site.entity.js';
import { User } from './user.entity.js';

/** CNT-03. `pending_review` is the Author → Editor queue (GOV-07). */
export enum ContentStatus {
  Draft = 'draft',
  PendingReview = 'pending_review',
  Published = 'published',
  Scheduled = 'scheduled',
}

/**
 * Every page, post and custom-type item. One row per item; the layout lives in code.
 *
 * - `blocks`: the drag-and-drop layout. Its shape is the contract in `cms-blocks/types.ts`
 *   (CLAUDE.md invariant 7).
 * - `data`: custom field values, keyed by the content type's field definitions.
 *
 * `path` is the full public URL path (`/about/team`, `/events/summer-gala`), denormalised so a
 * visit is one indexed lookup on `(site_id, path)`. A slug change recomputes it for every
 * descendant in one transaction (invariant 9). Unique per site including trashed rows, so a
 * trashed page's path is only freed by permanent delete (CNT-11).
 *
 * The type and the parent are referenced together with `site_id`, so a row can never point at
 * another tenant's type or page.
 */
@Entity('content')
@Unique(['siteId', 'path'])
@Unique(['siteId', 'id'])
@Index(['siteId', 'contentTypeId', 'status'])
@Index(['siteId', 'parentId'])
@Index(['ogImageId'])
@Index(['createdBy'])
@Index(['updatedBy'])
@ForeignKey(() => ContentType, ['siteId', 'contentTypeId'], ['siteId', 'id'])
@ForeignKey(() => Content, ['siteId', 'parentId'], ['siteId', 'id'])
@Check(
  'content_scheduled_has_time_check',
  `"status" <> 'scheduled' OR "scheduled_at" IS NOT NULL`,
)
@Check(
  'content_not_own_parent_check',
  `"parent_id" IS NULL OR "parent_id" <> "id"`,
)
export class Content extends TimestampedEntity {
  @Column('uuid')
  @ForeignKey(() => Site, { onDelete: 'CASCADE' })
  siteId: string;

  @Column('uuid')
  contentTypeId: string;

  /** Page tree only. A page with children cannot be permanently deleted. */
  @Column('uuid', { nullable: true })
  parentId: string | null;

  @Column('text')
  title: string;

  @Column('text')
  slug: string;

  @Column('text')
  path: string;

  @Column({
    type: 'enum',
    enum: ContentStatus,
    enumName: 'content_status',
    default: ContentStatus.Draft,
  })
  status: ContentStatus;

  @Column('jsonb', { default: () => "'[]'" })
  blocks: unknown[];

  @Column('jsonb', { default: () => "'{}'" })
  data: Record<string, unknown>;

  @Column('text', { nullable: true })
  seoTitle: string | null;

  @Column('text', { nullable: true })
  seoDescription: string | null;

  @Column('text', { nullable: true })
  canonicalUrl: string | null;

  @Column('uuid', { nullable: true })
  @ForeignKey(() => Media, { onDelete: 'SET NULL' })
  ogImageId: string | null;

  /** Emits `<meta name="robots" content="noindex">` and keeps the page out of the sitemap. */
  @Column('boolean', { default: false })
  noIndex: boolean;

  @Column('timestamptz', { nullable: true })
  publishedAt: Date | null;

  @Column('timestamptz', { nullable: true })
  scheduledAt: Date | null;

  /** Set = in the trash. TypeORM's `find` skips these unless asked with `withDeleted`. */
  @DeleteDateColumn({ type: 'timestamptz' })
  deletedAt: Date | null;

  @Column('uuid', { nullable: true })
  @ForeignKey(() => User, { onDelete: 'SET NULL' })
  createdBy: string | null;

  @Column('uuid', { nullable: true })
  @ForeignKey(() => User, { onDelete: 'SET NULL' })
  updatedBy: string | null;
}
