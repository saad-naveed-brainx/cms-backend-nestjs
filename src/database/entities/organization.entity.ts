import { Column, Entity, ForeignKey, Index } from 'typeorm';
import { TimestampedEntity } from './base.entity.js';
import { User } from './user.entity.js';

/** The client company. Owns one or more sites. */
@Entity('organizations')
@Index(['ownerId'])
export class Organization extends TimestampedEntity {
  @Column('text')
  name: string;

  /**
   * No cascade: the owning user cannot be deleted while they own an organization. `null` while the
   * organization waits for its first owner to use their invitation (platform-admin plan D1, D-062).
   */
  @Column('uuid', { nullable: true })
  @ForeignKey(() => User)
  ownerId: string | null;

  /** When the platform suspended it (its websites are unavailable and nobody may change anything); `null` when active. */
  @Column('timestamptz', { nullable: true })
  suspendedAt: Date | null;
}
