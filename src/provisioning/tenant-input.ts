import { z } from 'zod';

/** A name people read: tidied (trimmed), then 1 to 120 characters. */
const displayName = z.string().trim().min(1).max(120);

/**
 * What it takes to create a tenant (FND-06). The email is tidied (trimmed, lower-cased) and then
 * checked, the way login does it. A password, when given, is checked as it is and never trimmed:
 * spaces are part of it. At most 256 characters, so a huge one cannot make the hashing expensive.
 * The web addresses are only checked for being text here: the service tidies each one with
 * `normalizeHost` and names any it cannot accept.
 */
export const tenantInputSchema = z.object({
  organizationName: displayName,
  siteName: displayName,
  hostnames: z.array(z.string()).min(1).max(10),
  admin: z.object({
    email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
    name: displayName,
    password: z.string().min(12).max(256).optional(),
  }),
});

export type TenantInput = z.infer<typeof tenantInputSchema>;

/**
 * What it takes to add a site to an organisation the person owns (GOV-08a). Strict: a field that is
 * not listed (an owner, a site id) is refused, never ignored. `organizationId` is only needed when
 * the person owns more than one organisation.
 */
export const siteInputSchema = z.strictObject({
  name: displayName,
  hostnames: z.array(z.string()).min(1).max(10),
  organizationId: z.uuid().optional(),
});

export type SiteInput = z.infer<typeof siteInputSchema>;

/** The input is not acceptable. `problems` is one readable line each, and the message lists them all. */
export class ProvisionInputError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(problems.join('\n'));
    this.name = 'ProvisionInputError';
    this.problems = problems;
  }
}

/** Another site already answers on this web address. Nothing was created. */
export class HostnameTakenError extends Error {
  readonly hostname: string;

  constructor(hostname: string) {
    super(`The web address "${hostname}" is already used by another site`);
    this.name = 'HostnameTakenError';
    this.hostname = hostname;
  }
}

/** The person does not own the organisation (or owns none), so they may not add a site to it. */
export class NotOrganizationOwnerError extends Error {
  constructor() {
    super('Only the owner of an organisation can add a site to it');
    this.name = 'NotOrganizationOwnerError';
  }
}

/** The person owns more than one organisation and did not say which one the site is for. */
export class OrganizationRequiredError extends Error {
  constructor() {
    super('You own more than one organisation: say which one the site is for');
    this.name = 'OrganizationRequiredError';
  }
}
