import { randomBytes } from 'node:crypto';
import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { z } from 'zod';
import { AuthService } from '../auth/auth.service.js';
import { PasswordService } from '../auth/password.service.js';
import { parseOr400 } from '../content/content-input.js';
import { NewAccount } from '../invitations/new-account.js';
import {
  hashToken,
  INVITATION_LIFETIME_MS,
  newToken,
} from '../invitations/invitation-token.js';
import { MediaStorage } from '../media/media-storage.js';
import { SiteResolver } from '../sites/site-resolver.service.js';
import { WebsiteCache } from '../website/website-cache.service.js';
import { PlatformRepository } from '../platform/platform.repository.js';
import {
  organizationInputSchema,
  ProvisionInputError,
} from '../provisioning/tenant-input.js';
import { PlatformAdminRepository } from './platform-admin.repository.js';

const GENERATED_PASSWORD_BYTES = 18;

/** An email, tidied (trimmed, lower-cased) and then checked, the way login does it. */
const email = z.string().trim().toLowerCase().pipe(z.email().max(254));

/**
 * What it takes to make a super admin from the command line. The password is checked as it is and
 * never trimmed; at most 256 characters so a huge one cannot make the hashing expensive.
 */
const grantSchema = z.strictObject({
  email,
  name: z.string().trim().min(1).max(120).optional(),
  password: z.string().min(12).max(256).optional(),
});

/**
 * What it takes to create an organisation for an owner: the name (the rule of `POST /sites`'s
 * organisations: trimmed, 1 to 100, no NUL), the owner's email, and the owner's name, which is only
 * used when the email has no account yet. Strict: a field that is not listed is refused.
 */
const createOrganizationSchema = z.strictObject({
  name: organizationInputSchema.shape.name,
  ownerEmail: email,
  ownerName: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .refine((value) => !value.includes('\u0000'), {
      message: 'must not contain a NUL character',
    })
    .optional(),
});

const INVALID_OWNER_LINK = 'This invite is no longer valid. Ask for a new one.';
const ACCOUNT_EXISTS = 'This email already has an account. Sign in to join.';
const INVALID_CREDENTIALS = 'Invalid email or password';

/** The owner's email and name for a new link: the name is needed, there being no account to take it from. */
const issueSchema = z.strictObject({
  ownerEmail: email,
  ownerName: createOrganizationSchema.shape.ownerName.unwrap(),
  removeOld: z.boolean().optional(),
});

/** Change owner: the new owner's email, their name when the email has no account, and whether the old owner is removed. */
const changeOwnerSchema = z.strictObject({
  ownerEmail: email,
  ownerName: createOrganizationSchema.shape.ownerName,
  removeOld: z.boolean().optional(),
});

const deleteSchema = z.strictObject({ confirmName: z.string() });

const revokeSchema = z.strictObject({ email });

export type GrantResult = {
  id: string;
  email: string;
  created: boolean;
  /** Shown once by the command, only for a new account that was given no password. */
  generatedPassword?: string;
};

/** What the Platform screen lists for each organisation. */
export type PlatformOrganization = {
  id: string;
  name: string;
  status: 'active' | 'suspended' | 'awaiting_owner';
  owner: { id: string; email: string; name: string } | null;
  /** The email a waiting owner link is for: the first owner's, or a handover while the owner stays. */
  pendingOwnerEmail: string | null;
  websites: number;
  /** ISO 8601. */
  createdAt: string;
};

/** What creating an organisation answers: the owner, or the one-time link that will make one. */
export type CreatedOrganization = {
  id: string;
  name: string;
  owner: { id: string; email: string; name: string } | null;
  /** Present once, only when the owner has no account yet. The secret is never stored. */
  ownerInvitation: {
    email: string;
    name: string;
    token: string;
    /** ISO 8601. */
    expiresAt: string;
  } | null;
};

/** What the invite page shows for an owner link (D-062): `kind: 'owner'` tells it from a website's invitation. */
export type OwnerInvitationLookup = {
  kind: 'owner';
  organization: { id: string; name: string };
  email: string;
  /** The name the super admin gave for the new owner, to prefill the form. */
  name: string;
  hasAccount: boolean;
  /** ISO 8601. */
  expiresAt: string;
};

/** The super admin: the command now, and the platform routes (platform-admin T1, T2). */
@Injectable()
export class PlatformAdminService {
  constructor(
    private readonly platform: PlatformRepository,
    private readonly passwords: PasswordService,
    private readonly auth: AuthService,
    private readonly repository: PlatformAdminRepository,
    private readonly resolver: SiteResolver,
    private readonly website: WebsiteCache,
    private readonly media: MediaStorage,
  ) {}

  /**
   * Makes a super admin. An existing account keeps its name and password and supplying either is an
   * error; a new account needs a name, and a password (24 random characters, returned once, when none
   * is given). Throws `ProvisionInputError` for input it cannot accept; nothing is written then.
   */
  async grant(rawInput: unknown): Promise<GrantResult> {
    const parsed = grantSchema.safeParse(rawInput);
    if (!parsed.success) throw problemsOf(parsed.error);
    const { email: address, name, password } = parsed.data;

    const existing = await this.platform.findUserByEmail(address);
    if (existing && (name !== undefined || password !== undefined)) {
      throw new ProvisionInputError([
        `The account "${address}" already exists and keeps its current name and password: omit --name and the password`,
      ]);
    }
    if (!existing && name === undefined) {
      throw new ProvisionInputError([
        `There is no account "${address}": give --name to make one`,
      ]);
    }

    let account: { name: string; passwordHash: string } | null = null;
    let generatedPassword: string | undefined;
    if (!existing && name !== undefined) {
      const plain =
        password ?? randomBytes(GENERATED_PASSWORD_BYTES).toString('base64url');
      if (password === undefined) generatedPassword = plain;
      account = { name, passwordHash: await this.passwords.hash(plain) };
    }

    const granted = await this.repository.grantPlatformAdmin(address, account);
    if (!granted) {
      throw new ProvisionInputError([`There is no account "${address}"`]);
    }
    return {
      ...granted,
      ...(generatedPassword === undefined ? {} : { generatedPassword }),
    };
  }

  /** Every organisation with its owner and website count, by name. */
  async listOrganizations(): Promise<PlatformOrganization[]> {
    const rows = await this.repository.listOrganizations();
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      status: row.suspendedAt
        ? 'suspended'
        : row.ownerId === null
          ? 'awaiting_owner'
          : 'active',
      owner:
        row.ownerId === null
          ? null
          : { id: row.ownerId, email: row.ownerEmail!, name: row.ownerName! },
      pendingOwnerEmail: row.pendingOwnerEmail,
      websites: row.websites,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  /**
   * Makes an organisation for an owner (D-062). An email that has an account makes that person the
   * owner at once (`ownerName` is then ignored: they keep their name). Otherwise `ownerName` is
   * required and the organisation waits, with no owner, for a one-time link that is answered here
   * once and stored only as its fingerprint. Throws `ProvisionInputError` for input it cannot
   * accept; nothing is made then.
   */
  async createOrganization(
    superAdminId: string,
    rawInput: unknown,
  ): Promise<CreatedOrganization> {
    const parsed = createOrganizationSchema.safeParse(rawInput);
    if (!parsed.success) throw problemsOf(parsed.error);
    const { name, ownerEmail, ownerName } = parsed.data;

    const existing = await this.platform.findUserByEmail(ownerEmail);
    if (existing) {
      const created = await this.repository.createOrganization({
        name,
        invitedBy: superAdminId,
        owner: { userId: existing.id },
      });
      return {
        ...created,
        owner: { id: existing.id, email: existing.email, name: existing.name },
        ownerInvitation: null,
      };
    }

    if (ownerName === undefined) {
      throw new ProvisionInputError([
        `ownerName: there is no account "${ownerEmail}", so the new owner's name is needed`,
      ]);
    }
    const token = newToken();
    const expiresAt = new Date(Date.now() + INVITATION_LIFETIME_MS);
    const created = await this.repository.createOrganization({
      name,
      invitedBy: superAdminId,
      owner: {
        email: ownerEmail,
        name: ownerName,
        tokenHash: hashToken(token),
        expiresAt,
      },
    });
    return {
      ...created,
      owner: null,
      ownerInvitation: {
        email: ownerEmail,
        name: ownerName,
        token,
        expiresAt: expiresAt.toISOString(),
      },
    };
  }

  /**
   * Makes a fresh owner link for an organisation that has no owner yet, replacing any waiting one
   * (the old link stops working). Answers the link's secret once; only its fingerprint is stored.
   * `null` when there is no such organisation, or it already has an owner.
   */
  async issueOwnerInvitation(
    superAdminId: string,
    organizationId: string,
    rawInput: unknown,
  ): Promise<NonNullable<CreatedOrganization['ownerInvitation']> | null> {
    const parsed = issueSchema.safeParse(rawInput);
    if (!parsed.success) throw problemsOf(parsed.error);
    const { ownerEmail, ownerName, removeOld } = parsed.data;
    const token = newToken();
    const expiresAt = new Date(Date.now() + INVITATION_LIFETIME_MS);
    const issued = await this.repository.issueOwnerInvitation(organizationId, {
      email: ownerEmail,
      name: ownerName,
      tokenHash: hashToken(token),
      expiresAt,
      invitedBy: superAdminId,
      removePreviousOwner: removeOld === true,
    });
    if (!issued) return null;
    return {
      email: ownerEmail,
      name: ownerName,
      token,
      expiresAt: expiresAt.toISOString(),
    };
  }

  /**
   * Changes an organisation's owner (D-062). An email that has an account makes that person the owner at
   * once and Administrator on every website; a new email needs `ownerName` and leaves the owner as it is
   * until the one-time link is used. `removeOld` takes the old owner off the websites (at once, or when the
   * link is used). `null` for an organisation that does not exist.
   */
  async changeOwner(
    superAdminId: string,
    organizationId: string,
    rawInput: unknown,
  ): Promise<Omit<CreatedOrganization, 'name'> | null> {
    const parsed = changeOwnerSchema.safeParse(rawInput);
    if (!parsed.success) throw problemsOf(parsed.error);
    const { ownerEmail, ownerName, removeOld } = parsed.data;

    const existing = await this.platform.findUserByEmail(ownerEmail);
    if (existing) {
      const done = await this.repository.assignOwner(
        organizationId,
        existing.id,
        removeOld === true,
      );
      if (!done) return null;
      return {
        id: organizationId,
        owner: { id: existing.id, email: existing.email, name: existing.name },
        ownerInvitation: null,
      };
    }
    if (ownerName === undefined) {
      throw new ProvisionInputError([
        `ownerName: there is no account "${ownerEmail}", so the new owner's name is needed`,
      ]);
    }
    const ownerInvitation = await this.issueOwnerInvitation(
      superAdminId,
      organizationId,
      {
        ownerEmail,
        ownerName,
        removeOld,
      },
    );
    if (!ownerInvitation) return null;
    return { id: organizationId, owner: null, ownerInvitation };
  }

  /**
   * Deletes an organisation for good (D-062): every website, everything on them and the organisation, in
   * one transaction, the name typed exactly (trimmed). Afterwards the API's address memory, the public
   * website's pages and the uploaded pictures' files of every website are forgotten. `'not-found'` or
   * `'deleted'`; a wrong name is a `ProvisionInputError` and nothing is deleted.
   */
  async deleteOrganization(
    organizationId: string,
    rawInput: unknown,
  ): Promise<'not-found' | 'deleted'> {
    const parsed = deleteSchema.safeParse(rawInput);
    if (!parsed.success) throw problemsOf(parsed.error);
    const result = await this.repository.deleteOrganization(
      organizationId,
      parsed.data.confirmName.trim(),
    );
    if (result.outcome === 'not-found') return 'not-found';
    if (result.outcome === 'name-mismatch') {
      throw new ProvisionInputError([
        "confirmName: type the organization's exact name to delete it",
      ]);
    }
    for (const siteId of result.siteIds) {
      this.resolver.invalidateSite(siteId);
      await this.media.removeSite(siteId);
    }
    await this.website.forgetHosts(
      result.hostnames,
      `deleted organization ${organizationId}`,
    );
    return 'deleted';
  }

  /** What the invite page shows for an owner link. Used, replaced, expired and unknown links are the same 404. */
  async lookupOwnerInvitation(token: string): Promise<OwnerInvitationLookup> {
    const found = await this.repository.findOwnerInvitationByTokenHash(
      hashToken(token),
    );
    if (!found || found.expiresAt.getTime() <= Date.now()) {
      throw new NotFoundException(INVALID_OWNER_LINK);
    }
    return {
      kind: 'owner',
      organization: { id: found.organizationId, name: found.organizationName },
      email: found.email,
      name: found.name,
      hasAccount: found.hasAccount,
      expiresAt: found.expiresAt.toISOString(),
    };
  }

  /**
   * Accepts an owner link and answers the new owner's user id, who is then signed in by the caller. As
   * for a website's invitation: an email that has an account signs in with its password (a wrong one is a
   * 401, or a 409 when a name was sent); a new one needs `name` and a password of 12 or more characters.
   * One transaction in the desk makes the owner and their Administrator role on the organisation's
   * websites, and the link is used up.
   */
  async acceptOwnerInvitation(
    token: string,
    password: string,
    name: unknown,
  ): Promise<string> {
    const tokenHash = hashToken(token);
    const found =
      await this.repository.findOwnerInvitationByTokenHash(tokenHash);
    if (!found || found.expiresAt.getTime() <= Date.now()) {
      throw new NotFoundException(INVALID_OWNER_LINK);
    }

    let result;
    if (found.hasAccount) {
      const user = await this.auth.checkPassword(found.email, password);
      if (!user) {
        // A name means the person filled in "Create your account": it exists now, so say so.
        if (name !== undefined) throw new ConflictException(ACCOUNT_EXISTS);
        throw new UnauthorizedException(INVALID_CREDENTIALS);
      }
      result = await this.repository.acceptOwnerInvitation(tokenHash, {
        kind: 'existing',
        userId: user.id,
      });
    } else {
      // The accept route is public and not wrapped by `toHttpError`: a bad form is a 400 here.
      const account = parseOr400(NewAccount, { name, password });
      result = await this.repository.acceptOwnerInvitation(tokenHash, {
        kind: 'new',
        name: account.name,
        passwordHash: await this.passwords.hash(account.password),
      });
    }

    switch (result.outcome) {
      case 'accepted':
        return result.userId;
      case 'account-exists':
        throw new ConflictException(ACCOUNT_EXISTS);
      case 'account-gone':
        throw new UnauthorizedException(INVALID_CREDENTIALS);
      default:
        throw new NotFoundException(INVALID_OWNER_LINK);
    }
  }

  /**
   * Suspends or reactivates an organisation (D-062): its websites become unavailable to visitors and
   * read-only to members, or the other way round. Every cache that remembers one of its websites is
   * told to forget it (the API's address memory and the public website's pages, invariant 6). `null`
   * for an organisation that does not exist. Doing it twice changes nothing.
   */
  async setSuspended(
    organizationId: string,
    suspended: boolean,
  ): Promise<{ id: string; status: 'suspended' | 'active' } | null> {
    const changed = await this.repository.setSuspended(
      organizationId,
      suspended,
    );
    if (!changed) return null;
    for (const siteId of changed.siteIds) this.resolver.invalidateSite(siteId);
    await this.website.forgetHosts(
      changed.hostnames,
      `organization ${organizationId}`,
    );
    return { id: organizationId, status: suspended ? 'suspended' : 'active' };
  }

  /** Takes the flag off. Throws `ProvisionInputError` for a bad email or an email with no account. */
  async revoke(rawInput: unknown): Promise<{ email: string }> {
    const parsed = revokeSchema.safeParse(rawInput);
    if (!parsed.success) throw problemsOf(parsed.error);
    const found = await this.repository.revokePlatformAdmin(parsed.data.email);
    if (!found) {
      throw new ProvisionInputError([
        `There is no account "${parsed.data.email}"`,
      ]);
    }
    return { email: parsed.data.email };
  }
}

function problemsOf(error: z.ZodError): ProvisionInputError {
  return new ProvisionInputError(
    error.issues.map(
      (issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`,
    ),
  );
}
