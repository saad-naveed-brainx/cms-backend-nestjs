import { Column, Entity, ForeignKey, Index } from 'typeorm';
import { TimestampedEntity } from './base.entity.js';
import { Organization } from './organization.entity.js';

/**
 * One website, and the tenant boundary. Every tenant-owned table carries `site_id` and
 * cascades from here, so deleting a site deletes everything inside it.
 */
@Entity('sites')
@Index(['organizationId'])
export class Site extends TimestampedEntity {
  /** No cascade: an organization cannot be deleted while it still has sites. */
  @Column('uuid')
  @ForeignKey(() => Organization)
  organizationId: string;

  @Column('text')
  name: string;

  /** Palette, type set, shape, density. Flattened to `--site-*` CSS variables when rendering. */
  @Column('jsonb', { default: () => "'{}'" })
  theme: Record<string, unknown>;

  /** Header and footer content and the logo's media id (GOV-04). */
  @Column('jsonb', { default: () => "'{}'" })
  settings: Record<string, unknown>;
}
