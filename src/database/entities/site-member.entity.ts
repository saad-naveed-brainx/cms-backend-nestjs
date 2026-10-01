import { Column, Entity, ForeignKey, Index, Unique } from 'typeorm';
import { TimestampedEntity } from './base.entity.js';
import { Role } from './role.entity.js';
import { Site } from './site.entity.js';
import { User } from './user.entity.js';

/**
 * Which user has which role on which site. One role per user per site.
 *
 * The role is referenced as `(site_id, role_id)`, not `role_id` alone, so the database rejects a
 * membership on Corrick that points at one of Bakery's roles. No cascade on the role: a role
 * that still has members cannot be deleted.
 */
@Entity('site_members')
@Unique(['siteId', 'userId'])
@Index(['siteId', 'roleId'])
@Index(['userId'])
@ForeignKey(() => Role, ['siteId', 'roleId'], ['siteId', 'id'])
export class SiteMember extends TimestampedEntity {
  @Column('uuid')
  @ForeignKey(() => Site, { onDelete: 'CASCADE' })
  siteId: string;

  @Column('uuid')
  @ForeignKey(() => User, { onDelete: 'CASCADE' })
  userId: string;

  @Column('uuid')
  roleId: string;
}
