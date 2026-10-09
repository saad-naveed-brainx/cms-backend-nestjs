import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { z } from 'zod';
import { PasswordService } from '../auth/password.service.js';
import { Permission } from '../auth/permission.js';
import { PlatformRepository } from '../platform/platform.repository.js';
import { normalizeHost } from '../sites/normalize-host.js';
import { SiteResolver } from '../sites/site-resolver.service.js';
import {
  ADMINISTRATOR_ROLE,
  ProvisioningRepository,
} from './provisioning.repository.js';
import {
  NotOrganizationOwnerError,
  OrganizationRequiredError,
  ProvisionInputError,
  siteInputSchema,
  tenantInputSchema,
  type TenantInput,
} from './tenant-input.js';

/**
 * What was created. The ids and names are what the caller needs to find the tenant again; the
 * generated password is the one thing that is shown once and never stored in the clear. A password
 * the caller supplied is never in here, and neither is any hash.
 */
export type ProvisionResult = {
  organization: { id: string; name: string };
  site: { id: string; name: string };
  hostnames: string[];
  admin: {
    id: string;
    email: string;
    created: boolean;
    /** Only when this call made the password up. */
    generatedPassword?: string;
  };
};

/** A site added to an organisation the person owns: what was made, and the person's place in it. */
export type ProvisionedSite = {
  organization: { id: string; name: string };
  site: { id: string; name: string };
  hostnames: string[];
  membership: {
    site: { id: string; name: string };
    role: { id: string; name: string };
    permissions: Permission[];
  };
};

/** 18 random bytes make exactly 24 base64url characters, with no padding. */
const GENERATED_PASSWORD_BYTES = 18;

/**
 * Creates a whole tenant from details given at run time (FND-06): checks and tidies the input,
 * decides the first admin's password, and hands the all-or-nothing write to the provisioning desk.
 * The seed command calls it today; creating a second tenant from the admin panel will call it too.
 */
@Injectable()
export class ProvisioningService {
  constructor(
    private readonly platform: PlatformRepository,
    private readonly passwords: PasswordService,
    private readonly repository: ProvisioningRepository,
    private readonly resolver: SiteResolver,
  ) {}

  /**
   * Throws `ProvisionInputError` for input it cannot accept (every problem is listed) and
   * `HostnameTakenError` for an address another site holds. In both cases nothing was created.
   *
   * The admin's password:
   * - a user with that email already exists: they keep theirs (and their name: the one given here
   *   is only used for a new user), and supplying a password is an error;
   * - a new user with a supplied password: that password is hashed and stored;
   * - a new user without one: 24 random characters, hashed and stored, and returned once.
   */
  async provisionTenant(rawInput: unknown): Promise<ProvisionResult> {
    const input = parseInput(rawInput);
    const hostnames = tidyHostnames(input.hostnames);
    const { email, name, password } = input.admin;

    const existing = await this.platform.findUserByEmail(email);
    if (existing && password !== undefined) {
      throw new ProvisionInputError([
        `admin.password: the user "${email}" already exists and keeps their current password: omit the password`,
      ]);
    }

    let passwordHash: string | null = null;
    let generatedPassword: string | undefined;
    if (!existing) {
      const plain =
        password ?? randomBytes(GENERATED_PASSWORD_BYTES).toString('base64url');
      if (password === undefined) generatedPassword = plain;
      passwordHash = await this.passwords.hash(plain);
    }

    const created = await this.repository.createTenant({
      organizationName: input.organizationName,
      siteName: input.siteName,
      hostnames,
      admin: { email, name, passwordHash },
    });

    return {
      organization: {
        id: created.organizationId,
        name: input.organizationName,
      },
      site: { id: created.siteId, name: input.siteName },
      hostnames,
      admin: {
        id: created.userId,
        email,
        created: created.userCreated,
        ...(generatedPassword === undefined ? {} : { generatedPassword }),
      },
    };
  }

  /** The organisations this person owns: the ones they may add a site to. */
  ownedOrganizations(userId: string): Promise<{ id: string; name: string }[]> {
    return this.platform.findOrganizationsOwnedBy(userId);
  }

  /**
   * Adds a site to an organisation the person owns (GOV-08a): checks and tidies the input, picks
   * the organisation (the only one they own, or the one they name), and hands the all-or-nothing
   * write to the provisioning desk. The person becomes the new site's administrator.
   *
   * Throws `ProvisionInputError` for input it cannot accept, `OrganizationRequiredError` when they
   * own several and named none, `NotOrganizationOwnerError` when they own none or not the one
   * named, and `HostnameTakenError` for an address another site holds. Nothing is created then.
   */
  async provisionSite(
    userId: string,
    rawInput: unknown,
  ): Promise<ProvisionedSite> {
    const input = parseWith(siteInputSchema, rawInput);
    const hostnames = tidyHostnames(input.hostnames);

    const owned = await this.platform.findOrganizationsOwnedBy(userId);
    const organization = chooseOrganization(owned, input.organizationId);

    const created = await this.repository.createSite({
      organizationId: organization.id,
      siteName: input.name,
      hostnames,
      userId,
    });
    // The new addresses may have been asked about already ("unknown" is remembered for a while).
    this.resolver.invalidateSite(created.siteId);

    const site = { id: created.siteId, name: input.name };
    return {
      organization,
      site,
      hostnames,
      membership: {
        site,
        role: { id: created.roleId, name: ADMINISTRATOR_ROLE },
        permissions: Object.values(Permission),
      },
    };
  }
}

/** The input as the schema reads it, or a `ProvisionInputError` with a line for each problem. */
function parseWith<T extends z.ZodType>(
  schema: T,
  rawInput: unknown,
): z.infer<T> {
  const parsed = schema.safeParse(rawInput);
  if (parsed.success) return parsed.data;

  throw new ProvisionInputError(
    parsed.error.issues.map(
      (issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`,
    ),
  );
}

function parseInput(rawInput: unknown): TenantInput {
  return parseWith(tenantInputSchema, rawInput);
}

/**
 * Each address tidied the way the public lookup tidies one (`normalizeHost`), so what is stored
 * is what will be looked up. Repeats are dropped after tidying, keeping the first. Every address
 * that is not a web address is named, with its value.
 */
function tidyHostnames(raw: string[]): string[] {
  const problems: string[] = [];
  const tidied: string[] = [];

  raw.forEach((value, index) => {
    const host = normalizeHost(value);
    if (host === null) {
      problems.push(
        `hostnames.${index}: ${JSON.stringify(value)} is not a valid web address`,
      );
    } else if (!tidied.includes(host)) {
      tidied.push(host);
    }
  });

  if (problems.length > 0) throw new ProvisionInputError(problems);
  return tidied;
}

/**
 * The organisation a new site goes into: the one named, which must be one the person owns, or the
 * only one they own. Owning none, or not owning the one named, is `NotOrganizationOwnerError`;
 * owning several and naming none is `OrganizationRequiredError`.
 */
function chooseOrganization(
  owned: { id: string; name: string }[],
  named: string | undefined,
): { id: string; name: string } {
  if (named !== undefined) {
    const found = owned.find((item) => item.id === named);
    if (!found) throw new NotOrganizationOwnerError();
    return found;
  }
  if (owned.length > 1) throw new OrganizationRequiredError();
  const only = owned[0];
  if (!only) throw new NotOrganizationOwnerError();
  return only;
}
