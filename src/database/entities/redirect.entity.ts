import { Check, Column, Entity, ForeignKey, Unique } from 'typeorm';
import { TimestampedEntity } from './base.entity.js';
import { Site } from './site.entity.js';

/**
 * Old path → new path, served by the public site (GOV-05). Chains are collapsed on write: when
 * `/b` moves to `/c`, an existing `/a → /b` is rewritten to `/a → /c`, so a visitor is never
 * redirected twice.
 */
@Entity('redirects')
@Unique(['siteId', 'fromPath'])
@Check('redirects_status_code_check', `"status_code" IN (301, 302, 307, 308)`)
@Check('redirects_not_to_self_check', `"from_path" <> "to_path"`)
export class Redirect extends TimestampedEntity {
  @Column('uuid')
  @ForeignKey(() => Site, { onDelete: 'CASCADE' })
  siteId: string;

  @Column('text')
  fromPath: string;

  @Column('text')
  toPath: string;

  @Column('smallint', { default: 301 })
  statusCode: number;

  /** True when a slug change created it; false when an admin added it by hand. */
  @Column('boolean', { default: false })
  isAutomatic: boolean;
}
