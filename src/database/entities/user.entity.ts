import { Check, Column, Entity, Unique } from 'typeorm';
import { TimestampedEntity } from './base.entity.js';

/**
 * A person who can sign in. Not tenant-owned: one user can belong to many sites, with a role on
 * each (see SiteMember).
 *
 * Email is stored lowercased, enforced by a check constraint, so the unique constraint is
 * effectively case-insensitive: `Ayesha@Corrick.com` and `ayesha@corrick.com` cannot both exist.
 * The API must lowercase before writing.
 */
@Entity('users')
@Unique(['email'])
@Check('users_email_lowercase_check', `"email" = lower("email")`)
export class User extends TimestampedEntity {
  @Column('text')
  email: string;

  /**
   * Hash only, a scrypt string (`scrypt$N$r$p$salt$key`, made by PasswordService). A plaintext
   * password never reaches the database.
   */
  @Column('text')
  passwordHash: string;

  /** Shown as the author on content and revisions. */
  @Column('text')
  name: string;
}
