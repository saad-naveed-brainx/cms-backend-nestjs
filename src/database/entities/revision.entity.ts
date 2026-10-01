import { Column, Entity, ForeignKey, Index } from 'typeorm';
import { ImmutableEntity } from './base.entity.js';
import { Content } from './content.entity.js';
import { Site } from './site.entity.js';
import { User } from './user.entity.js';

/**
 * A snapshot written on every save (GOV-01). Never edited, so no `updated_at`.
 * Restoring copies the snapshot back into the content row as a draft.
 */
@Entity('revisions')
@Index(['siteId', 'contentId', 'createdAt'])
@Index(['createdBy'])
@ForeignKey(() => Content, ['siteId', 'contentId'], ['siteId', 'id'], {
  onDelete: 'CASCADE',
})
export class Revision extends ImmutableEntity {
  @Column('uuid')
  @ForeignKey(() => Site, { onDelete: 'CASCADE' })
  siteId: string;

  @Column('uuid')
  contentId: string;

  /** Title, slug, blocks, data and SEO fields as they were at this save. */
  @Column('jsonb')
  snapshot: Record<string, unknown>;

  @Column('uuid', { nullable: true })
  @ForeignKey(() => User, { onDelete: 'SET NULL' })
  createdBy: string | null;
}
