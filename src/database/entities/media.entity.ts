import { Check, Column, Entity, ForeignKey, Index, Unique } from 'typeorm';
import { TimestampedEntity } from './base.entity.js';
import { Site } from './site.entity.js';
import { User } from './user.entity.js';

/**
 * An uploaded file. Content and blocks reference it by `id`, never by file path, so replacing
 * the file only changes `storage_key` and every page using it keeps working (MED-02).
 */
@Entity('media')
@Unique(['storageKey'])
@Index(['siteId', 'createdAt'])
@Index(['uploadedBy'])
@Check('media_size_bytes_check', `"size_bytes" >= 0`)
export class Media extends TimestampedEntity {
  @Column('uuid')
  @ForeignKey(() => Site, { onDelete: 'CASCADE' })
  siteId: string;

  /** Original name as uploaded: "team-photo.jpg". */
  @Column('text')
  filename: string;

  /** Location on disk, scoped by site and unguessable: `<site_id>/<uuid>.jpg`. */
  @Column('text')
  storageKey: string;

  @Column('text')
  mimeType: string;

  /** `integer`, not `bigint`: the upload limit is far below 2 GB, and pg returns bigint as a string. */
  @Column('integer')
  sizeBytes: number;

  @Column('integer', { nullable: true })
  width: number | null;

  @Column('integer', { nullable: true })
  height: number | null;

  /** Generated thumbnail sizes: `{ "thumb": "<storage key>", "medium": "<storage key>" }`. */
  @Column('jsonb', { default: () => "'{}'" })
  variants: Record<string, string>;

  @Column('text', { nullable: true })
  altText: string | null;

  @Column('text', { nullable: true })
  title: string | null;

  @Column('text', { nullable: true })
  description: string | null;

  @Column('uuid', { nullable: true })
  @ForeignKey(() => User, { onDelete: 'SET NULL' })
  uploadedBy: string | null;
}
