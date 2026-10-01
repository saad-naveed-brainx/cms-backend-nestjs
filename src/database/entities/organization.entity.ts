import { Column, Entity, ForeignKey, Index } from 'typeorm';
import { TimestampedEntity } from './base.entity.js';
import { User } from './user.entity.js';

/** The client company. Owns one or more sites. */
@Entity('organizations')
@Index(['ownerId'])
export class Organization extends TimestampedEntity {
  @Column('text')
  name: string;

  /** No cascade: the owning user cannot be deleted while they own an organization. */
  @Column('uuid')
  @ForeignKey(() => User)
  ownerId: string;
}
