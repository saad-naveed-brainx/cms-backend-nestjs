import { Column, Entity, ForeignKey, Index } from 'typeorm';
import { ImmutableEntity } from './base.entity.js';
import { Content } from './content.entity.js';
import { Site } from './site.entity.js';

/** What a visitor sent through a form block (BLK-06). Never edited, so no `updated_at`. */
@Entity('form_submissions')
@Index(['siteId', 'createdAt'])
@Index(['contentId'])
export class FormSubmission extends ImmutableEntity {
  @Column('uuid')
  @ForeignKey(() => Site, { onDelete: 'CASCADE' })
  siteId: string;

  /** The page the form was on. Kept as null if that page is permanently deleted. */
  @Column('uuid', { nullable: true })
  @ForeignKey(() => Content, { onDelete: 'SET NULL' })
  contentId: string | null;

  /** The form block's fixed field set: name, email, message. */
  @Column('jsonb')
  data: Record<string, unknown>;
}
