import { Column, Entity, ForeignKey, Unique } from 'typeorm';
import { Permission } from '../../auth/permission.js';
import { TimestampedEntity } from './base.entity.js';
import { Site } from './site.entity.js';

/**
 * A named bundle of permissions, owned by one site. Each site has its own copies of the five
 * seeded roles, so Corrick can give its Contributors `media.upload` without touching Bakery's.
 *
 * `(site_id, id)` is unique so that SiteMember can reference a role together with its site,
 * which stops a member of one site from holding another site's role.
 */
@Entity('roles')
@Unique(['siteId', 'name'])
@Unique(['siteId', 'id'])
export class Role extends TimestampedEntity {
  @Column('uuid')
  @ForeignKey(() => Site, { onDelete: 'CASCADE' })
  siteId: string;

  @Column('text')
  name: string;

  @Column({
    type: 'enum',
    enum: Permission,
    enumName: 'permission',
    array: true,
    default: () => "'{}'",
  })
  permissions: Permission[];
}
