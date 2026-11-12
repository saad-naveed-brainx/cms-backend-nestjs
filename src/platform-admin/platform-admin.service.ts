import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { PasswordService } from '../auth/password.service.js';
import {
  hashToken,
  INVITATION_LIFETIME_MS,
  newToken,
} from '../invitations/invitations.service.js';
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
  /** The email an owner invitation waits for (`status: 'awaiting_owner'`). */
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

/** The super admin: the command now, and the platform routes (platform-admin T1, T2). */
@Injectable()
export class PlatformAdminService {
  constructor(
    private readonly platform: PlatformRepository,
    private readonly passwords: PasswordService,
    private readonly repository: PlatformAdminRepository,
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
      pendingOwnerEmail: row.ownerId === null ? row.pendingOwnerEmail : null,
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
