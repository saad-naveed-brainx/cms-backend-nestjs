import { Check, Column, Entity, ForeignKey, Index, Unique } from 'typeorm';
import { TimestampedEntity } from './base.entity.js';
import { Role } from './role.entity.js';
import { Site } from './site.entity.js';
import { User } from './user.entity.js';

/**
 * A waiting invitation to join one site with one of its roles (users-roles plan D3, D-047).
 *
 * The link's secret is never stored: only `tokenHash`, the SHA-256 (hex) of it, so reading the
 * database hands out no working invitation. Accepting or cancelling deletes the row, so a link
 * works once; one waiting invitation per email per site (a new one replaces it).
 *
 * The role is referenced as `(site_id, role_id)`, like `site_members`, so an invitation on one
 * site cannot carry another site's role. No cascade on the role. The inviter is a plain key that
 * becomes `null` when their account is deleted. Deleting the site deletes its invitations.
 */
@Entity('invitations')
@Unique(['siteId', 'email'])
@Unique(['tokenHash'])
@Index(['siteId', 'roleId'])
@Index(['invitedBy'])
@Check('invitations_email_lowercase_check', `"email" = lower("email")`)
@ForeignKey(() => Role, ['siteId', 'roleId'], ['siteId', 'id'])
export class Invitation extends TimestampedEntity {
  @Column('uuid')
  @ForeignKey(() => Site, { onDelete: 'CASCADE' })
  siteId: string;

  /** Lower case (check constraint); the API lower-cases before writing. */
  @Column('text')
  email: string;

  @Column('uuid')
  roleId: string;

  /** SHA-256 of the link's secret, as 64 hex characters. */
  @Column('text')
  tokenHash: string;

  @Column('timestamptz')
  expiresAt: Date;

  @Column('uuid', { nullable: true })
  @ForeignKey(() => User, { onDelete: 'SET NULL' })
  invitedBy: string | null;
}
