import { Injectable } from '@nestjs/common';
import { DataSource, QueryFailedError } from 'typeorm';
import {
  Invitation,
  Role,
  Site,
  SiteMember,
  User,
} from '../database/entities/index.js';
import { isUuid } from '../database/scoped.repository.js';

/** An invitation found by its link: what the invite page shows, and what accepting needs. */
export type FoundInvitation = {
  id: string;
  siteId: string;
  siteName: string;
  roleName: string;
  email: string;
  expiresAt: Date;
  /** A user with the invitation's email exists (anywhere on the platform, D-050). */
  hasAccount: boolean;
};

/** Who accepts: a new account (its password already hashed), or the existing one with this id. */
export type Acceptor =
  | { kind: 'new'; name: string; passwordHash: string }
  | { kind: 'existing'; userId: string };

/** What accepting did, or why nothing was written. */
export type Acceptance =
  | { outcome: 'accepted'; userId: string }
  /** No such invitation any more (used, cancelled, unknown) or it has expired. */
  | { outcome: 'invalid' }
  /** A new account was asked for, but an account with that email exists now. Invitation kept. */
  | { outcome: 'account-exists' }
  /** The existing account named is gone or no longer has the invitation's email. Invitation kept. */
  | { outcome: 'account-gone' };

/** Postgres' code for a unique violation, and the name the migration gives the users' email rule. */
const UNIQUE_VIOLATION = '23505';
const USER_EMAIL_UNIQUE_CONSTRAINT = 'users_email_key';

/**
 * The invitation acceptance desk: the FOURTH unscoped desk, next to the platform desk (reads),
 * the provisioning desk (creates sites) and the site removal desk (deletes sites)
 * (users-roles plan D5, docs/DECISIONS.md D-048).
 *
 * It exists because opening an invite link happens before any site is known: the invitation is
 * found by its secret's fingerprint, and accepting may create a user (a shared table) and a
 * membership in one all-or-nothing step. Everything an Administrator does with invitations stays
 * on the scoped `InvitationRepository`.
 *
 * Kept narrow on purpose: exactly two public methods. The site always comes from the invitation's
 * own row, never from the caller, and the email is the invitation's, never the caller's.
 */
@Injectable()
export class InvitationAcceptanceRepository {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * The invitation whose secret hashes to `tokenHash`, with its site's and role's names and
   * whether its email has an account, or `null` when there is none. An expired one is returned
   * (the caller decides); a malformed hash is `null` before any SQL.
   */
  async findByTokenHash(tokenHash: string): Promise<FoundInvitation | null> {
    if (!/^[0-9a-f]{64}$/.test(tokenHash)) return null;

    const row = await this.dataSource
      .getRepository(Invitation)
      .createQueryBuilder('invitation')
      .innerJoin(Site, 'site', 'site.id = invitation.siteId')
      .innerJoin(
        Role,
        'role',
        'role.siteId = invitation.siteId AND role.id = invitation.roleId',
      )
      .leftJoin(User, 'person', 'person.email = invitation.email')
      .select('invitation.id', 'id')
      .addSelect('invitation.siteId', 'siteId')
      .addSelect('site.name', 'siteName')
      .addSelect('role.name', 'roleName')
      .addSelect('invitation.email', 'email')
      .addSelect('invitation.expiresAt', 'expiresAt')
      .addSelect('person.id IS NOT NULL', 'hasAccount')
      .where('invitation.tokenHash = :tokenHash', { tokenHash })
      .getRawOne<{
        id: string;
        siteId: string;
        siteName: string;
        roleName: string;
        email: string;
        expiresAt: Date;
        hasAccount: boolean;
      }>();
    if (!row) return null;
    return {
      ...row,
      expiresAt: new Date(row.expiresAt),
      hasAccount: row.hasAccount === true,
    };
  }

  /**
   * Accepts the invitation in ONE transaction:
   * 1. lock its row (`SELECT … FOR UPDATE`), so a second accept of the same link waits here and
   *    then finds it gone: one link, one use;
   * 2. re-check it is there and not expired (`invalid` otherwise);
   * 3. create the new account, or check the existing one still has the invitation's email;
   * 4. add the membership with the invitation's role, unless they are already a member;
   * 5. delete the invitation.
   *
   * A new account whose email has an account by now is `account-exists` and nothing is written,
   * so the invitation stays for a sign-in. When that account is made between the check and the
   * insert (two people racing), the users' unique email rule refuses the insert, which aborts and
   * rolls back the whole transaction; that error is turned into the same `account-exists`.
   */
  async accept(tokenHash: string, acceptor: Acceptor): Promise<Acceptance> {
    if (!/^[0-9a-f]{64}$/.test(tokenHash)) return { outcome: 'invalid' };
    if (acceptor.kind === 'existing' && !isUuid(acceptor.userId)) {
      return { outcome: 'account-gone' };
    }

    try {
      return await this.dataSource.transaction(async (manager) => {
        const invitation = await manager.findOne(Invitation, {
          where: { tokenHash },
          lock: { mode: 'pessimistic_write' },
        });
        if (!invitation || invitation.expiresAt.getTime() <= Date.now()) {
          return { outcome: 'invalid' } as const;
        }

        let userId: string;
        if (acceptor.kind === 'new') {
          if (await manager.existsBy(User, { email: invitation.email })) {
            return { outcome: 'account-exists' } as const;
          }
          const user = await manager.save(
            manager.create(User, {
              email: invitation.email,
              name: acceptor.name,
              passwordHash: acceptor.passwordHash,
            }),
          );
          userId = user.id;
        } else {
          const user = await manager.existsBy(User, {
            id: acceptor.userId,
            email: invitation.email,
          });
          if (!user) return { outcome: 'account-gone' } as const;
          userId = acceptor.userId;
        }

        const member = await manager.existsBy(SiteMember, {
          siteId: invitation.siteId,
          userId,
        });
        if (!member) {
          await manager.save(
            manager.create(SiteMember, {
              siteId: invitation.siteId,
              userId,
              roleId: invitation.roleId,
            }),
          );
        }

        await manager.delete(Invitation, { id: invitation.id });
        return { outcome: 'accepted', userId } as const;
      });
    } catch (error) {
      if (isUserEmailTaken(error)) return { outcome: 'account-exists' };
      throw error;
    }
  }
}

/** The users' unique email rule refused the new account: someone made it after the check. */
function isUserEmailTaken(error: unknown): boolean {
  if (!(error instanceof QueryFailedError)) return false;
  const driverError = error.driverError as {
    code?: string;
    constraint?: string;
  };
  return (
    driverError.code === UNIQUE_VIOLATION &&
    driverError.constraint === USER_EMAIL_UNIQUE_CONSTRAINT
  );
}
