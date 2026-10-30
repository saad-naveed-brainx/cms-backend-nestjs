import { createHash, randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { z } from 'zod';
import { AuthService, type LoginResult } from '../auth/auth.service.js';
import { PasswordService } from '../auth/password.service.js';
import { parseOr400 } from '../content/content-input.js';
import {
  InvitationAcceptanceRepository,
  type Acceptance,
} from './invitation-acceptance.repository.js';
import {
  InvitationRepository,
  type InvitationView,
} from './invitation.repository.js';

/** How long a link works (plan D3). */
export const INVITATION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

export const INVALID_INVITATION_MESSAGE =
  'This invite is no longer valid. Ask for a new one.';
export const ACCOUNT_EXISTS_MESSAGE =
  'This email already has an account. Sign in to join.';
const INVALID_CREDENTIALS_MESSAGE = 'Invalid email or password';

/** A made or renewed invitation, with its link's secret: the only time the secret is ever shown. */
export type IssuedInvitation = { invitation: InvitationView; token: string };

/** What the invite page shows before the person accepts. */
export type InvitationLookup = {
  site: { name: string };
  role: { name: string };
  email: string;
  hasAccount: boolean;
  /** ISO 8601. */
  expiresAt: string;
};

/** A new account's details: the name trimmed, the password as typed (spaces are part of it). */
const NewAccount = z.object({
  name: z.string().trim().min(1).max(100),
  password: z.string().min(12).max(256),
});

/** 32 random bytes as base64url (43 characters): the secret after `#` in the link (plan D4). */
function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/** What the database keeps instead of the secret (D-047): its SHA-256, in hex. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Invitations (users-roles T3, plan D3, D7): an Administrator makes, renews and cancels them on
 * their site; the person holding a link looks it up and accepts it, as a new account or with
 * their existing password, and is signed in.
 *
 * The email always comes from the invitation and the site from its row, never from the request.
 */
@Injectable()
export class InvitationsService {
  constructor(
    private readonly invitations: InvitationRepository,
    private readonly acceptance: InvitationAcceptanceRepository,
    private readonly auth: AuthService,
    private readonly passwords: PasswordService,
  ) {}

  /** `email` is already trimmed and lower-cased. A waiting invite for it on this site is replaced. */
  async create(
    siteId: string,
    invitedBy: string,
    email: string,
    roleId: string,
  ): Promise<IssuedInvitation> {
    const token = newToken();
    const result = await this.invitations.createOrReplace(siteId, {
      email,
      roleId,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + INVITATION_LIFETIME_MS),
      invitedBy,
    });
    switch (result.outcome) {
      case 'created':
        return { invitation: result.invitation, token };
      case 'already-member':
        throw new ConflictException(
          `${email} is already a member of this site.`,
        );
      default:
        throw new BadRequestException({
          message: 'Invalid request',
          errors: ["roleId: That role is not one of this site's roles."],
        });
    }
  }

  /** A new link and a new 7 days for the invitation; its old link stops working. */
  async renew(siteId: string, id: string): Promise<IssuedInvitation> {
    const token = newToken();
    const invitation = await this.invitations.renew(
      siteId,
      id,
      hashToken(token),
      new Date(Date.now() + INVITATION_LIFETIME_MS),
    );
    if (!invitation) throw new NotFoundException('Invitation not found');
    return { invitation, token };
  }

  async cancel(siteId: string, id: string): Promise<void> {
    if (!(await this.invitations.cancel(siteId, id))) {
      throw new NotFoundException('Invitation not found');
    }
  }

  /** What the invite page shows. Used, cancelled, expired and unknown links are the same 404. */
  async lookup(token: string): Promise<InvitationLookup> {
    const found = await this.findValid(token);
    return {
      site: { name: found.siteName },
      role: { name: found.roleName },
      email: found.email,
      hasAccount: found.hasAccount,
      expiresAt: found.expiresAt.toISOString(),
    };
  }

  /**
   * Accepts the invitation and signs the person in. Whether they make a new account or sign in
   * with an existing one is decided here, now, by whether the invitation's email has an account:
   * - existing: `password` is checked as at sign-in; `name` is otherwise ignored. A wrong password
   *   is a 401, or, when a name was sent (the person filled in the new-account form, so the
   *   account appeared after they opened the page), the 409 "already has an account". Either way
   *   the invitation stays;
   * - new: `name` (1–100 after trimming) and `password` (12–256) are required; the account is made
   *   with the invitation's email.
   * The desk then does everything else in one transaction (see `InvitationAcceptanceRepository`).
   */
  async accept(
    token: string,
    password: string,
    name: unknown,
  ): Promise<LoginResult> {
    const found = await this.findValid(token);
    const tokenHash = hashToken(token);

    let result: Acceptance;
    if (found.hasAccount) {
      const userId = await this.verifyExistingAccount(found.email, password);
      if (!userId) {
        // A name means they filled in "Create your account": the account appeared since they
        // opened the page, so say so rather than "wrong password". The invitation stays.
        if (name !== undefined)
          throw new ConflictException(ACCOUNT_EXISTS_MESSAGE);
        throw new UnauthorizedException(INVALID_CREDENTIALS_MESSAGE);
      }
      result = await this.acceptance.accept(tokenHash, {
        kind: 'existing',
        userId,
      });
    } else {
      const account = parseOr400(NewAccount, { name, password });
      result = await this.acceptance.accept(tokenHash, {
        kind: 'new',
        name: account.name,
        passwordHash: await this.passwords.hash(account.password),
      });
    }

    switch (result.outcome) {
      case 'accepted': {
        const answer = await this.auth.signIn(result.userId);
        if (!answer) {
          throw new UnauthorizedException(INVALID_CREDENTIALS_MESSAGE);
        }
        return answer;
      }
      case 'account-exists':
        throw new ConflictException(ACCOUNT_EXISTS_MESSAGE);
      case 'account-gone':
        throw new UnauthorizedException(INVALID_CREDENTIALS_MESSAGE);
      default:
        throw new NotFoundException(INVALID_INVITATION_MESSAGE);
    }
  }

  /**
   * The ONE check of an existing account's password when accepting: the account's id, or `null`
   * for a wrong password. It goes through sign-in's own check, so the sign-in limit (T4) covers it.
   */
  private async verifyExistingAccount(
    email: string,
    password: string,
  ): Promise<string | null> {
    const user = await this.auth.checkPassword(email, password);
    return user?.id ?? null;
  }

  /** The invitation behind this link when it is there and not expired; otherwise the 404. */
  private async findValid(token: string) {
    const found = await this.acceptance.findByTokenHash(hashToken(token));
    if (!found || found.expiresAt.getTime() <= Date.now()) {
      throw new NotFoundException(INVALID_INVITATION_MESSAGE);
    }
    return found;
  }
}
