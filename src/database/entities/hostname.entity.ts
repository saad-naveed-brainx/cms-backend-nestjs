import { Check, Column, Entity, ForeignKey, Index, Unique } from 'typeorm';
import { TimestampedEntity } from './base.entity.js';
import { Site } from './site.entity.js';

/**
 * A domain a site answers on. A site can have several (`corrick.com`, `www.corrick.com`); the
 * primary one is canonical and the others redirect to it.
 *
 * Hostnames are globally unique: one hostname can only ever resolve to one site.
 */
@Entity('hostnames')
@Unique(['hostname'])
@Index(['siteId'])
@Index('hostnames_one_primary_per_site_idx', ['siteId'], {
  unique: true,
  where: '"is_primary"',
})
@Check('hostnames_hostname_lowercase_check', `"hostname" = lower("hostname")`)
export class Hostname extends TimestampedEntity {
  @Column('uuid')
  @ForeignKey(() => Site, { onDelete: 'CASCADE' })
  siteId: string;

  @Column('text')
  hostname: string;

  @Column('boolean', { default: false })
  isPrimary: boolean;
}
