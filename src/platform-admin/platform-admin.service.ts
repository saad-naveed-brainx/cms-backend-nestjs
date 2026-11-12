import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { PasswordService } from '../auth/password.service.js';
import { PlatformRepository } from '../platform/platform.repository.js';
import { ProvisionInputError } from '../provisioning/tenant-input.js';
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

const revokeSchema = z.strictObject({ email });

export type GrantResult = {
  id: string;
  email: string;
  created: boolean;
  /** Shown once by the command, only for a new account that was given no password. */
  generatedPassword?: string;
};

/** The command-line side of the super admin (platform-admin T1). The routes arrive in T2. */
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
