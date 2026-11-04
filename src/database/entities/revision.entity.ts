import { Column, Entity, ForeignKey, Index } from 'typeorm';
import { ImmutableEntity } from './base.entity.js';
import { Content } from './content.entity.js';
import { Site } from './site.entity.js';
import { User } from './user.entity.js';

/**
 * A version of a page: its content as it was at one save (GOV-01, version-history D-057 to D-060).
 * Never edited, so no `updated_at`. The pages desk writes one in the same transaction as the page
 * or the save that made it (`content.repository.ts`), and `RevisionRepository` only reads them.
 * Restoring is not done here: the admin loads an old version into the editor as unsaved changes,
 * and Save then writes a new version (D-058), so the history only ever grows.
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

  /**
   * Exactly the seven things Save accepts, as they were at this save: `title`, `blocks`, `data`,
   * `seoTitle`, `seoDescription`, `canonicalUrl`, `noIndex`. Not the address, parent or status:
   * those do not change through Save, and restoring a version never moves a page.
   */
  @Column('jsonb')
  snapshot: Record<string, unknown>;

  @Column('uuid', { nullable: true })
  @ForeignKey(() => User, { onDelete: 'SET NULL' })
  createdBy: string | null;
}
