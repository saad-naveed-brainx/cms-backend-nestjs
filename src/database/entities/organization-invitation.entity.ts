import { Check, Column, Entity, ForeignKey, Index, Unique } from 'typeorm';
import { TimestampedEntity } from './base.entity.js';
import { Organization } from './organization.entity.js';
import { User } from './user.entity.js';

/**
 * A waiting invitation to become the OWNER of an organization (platform-admin plan D1, D-062).
 * Site invitations belong to a website; a brand-new owner has none to be invited to, so this one
 * belongs to the organization.
 *
 * Like a site invitation (D-047) the link's secret is never stored, only `tokenHash` (SHA-256, hex);
 * accepting deletes the row, so a link works once; one waiting owner invitation per organization (a
 * new one replaces it). Deleting the organization deletes it. The inviter (the super admin) becomes
 * `null` when their account is deleted.
 */
@Entity('organization_invitations')
@Unique(['organizationId'])
@Unique(['tokenHash'])
@Index(['invitedBy'])
@Check(
  'organization_invitations_email_lowercase_check',
  `"email" = lower("email")`,
)
export class OrganizationInvitation extends TimestampedEntity {
  @Column('uuid')
  @ForeignKey(() => Organization, { onDelete: 'CASCADE' })
  organizationId: string;

  /** Lower case (check constraint); the API lower-cases before writing. */
  @Column('text')
  email: string;

  /** What a new owner's account is named, when the email has no account yet. */
  @Column('text')
  name: string;

  /** SHA-256 of the link's secret, as 64 hex characters. */
  @Column('text')
  tokenHash: string;

  @Column('timestamptz')
  expiresAt: Date;

  /**
   * When the organisation already has an owner (a handover, plan D6), the link also takes the old owner off
   * the organisation's websites once it is used. Only meaningful then.
   */
  @Column('boolean', { default: false })
  removePreviousOwner: boolean;

  @Column('uuid', { nullable: true })
  @ForeignKey(() => User, { onDelete: 'SET NULL' })
  invitedBy: string | null;
}
