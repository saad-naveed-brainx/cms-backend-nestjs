import { createHash } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import type { RoleName } from '../../src/auth/roles.js';
import { ProvisioningService } from '../../src/provisioning/provisioning.service.js';

/**
 * Helpers for the invitation tests (users-roles T3): a client made by the real provisioning
 * service with its owner signed in, a site's role id read from the table (not from the route under
 * test), and an invitation made through the real route.
 */

/** What every dead link answers: used, expired, cancelled or never made (UC-UR-11). */
export const INVITE_GONE = 'This invite is no longer valid. Ask for a new one.';

export const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export type Client = {
  siteId: string;
  userId: string;
  name: string;
  token: string;
  headers: { Authorization: string; 'X-Site-Id': string };
};

/** A new organisation and site; its owner (an Administrator) signed in with the real login. */
export async function newClient(
  app: INestApplication,
  fields: { prefix: string; adminName: string; siteName: string },
): Promise<Client> {
  const { prefix, adminName, siteName } = fields;
  const email = `${prefix}-owner@${prefix}.test`;
  const password = `${prefix}-owner-password`;
  const tenant = await app.get(ProvisioningService).provisionTenant({
    organizationName: `${siteName} Ltd`,
    siteName,
    hostnames: [`${prefix}.test`],
    admin: { email, name: adminName, password },
  });
  const login = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password })
    .expect(200);
  const token = login.body.accessToken as string;
  return {
    siteId: tenant.site.id,
    userId: tenant.admin.id,
    name: adminName,
    token,
    headers: { Authorization: `Bearer ${token}`, 'X-Site-Id': tenant.site.id },
  };
}

/** A site's role id by name, read from the table. */
export async function roleIdOf(
  app: INestApplication,
  siteId: string,
  name: RoleName,
): Promise<string> {
  const [row] = await app
    .get(DataSource)
    .query<{ id: string }[]>(
      'SELECT id FROM roles WHERE site_id = $1 AND name = $2',
      [siteId, name],
    );
  if (!row) throw new Error(`roleIdOf: site ${siteId} has no role "${name}"`);
  return row.id;
}

export type Invited = {
  id: string;
  token: string;
  invitation: Record<string, any>;
};

/** `POST /invitations` as `who`; fails the test unless it is a 201. */
export async function invite(
  app: INestApplication,
  who: { headers: Record<string, string> },
  email: string,
  role: RoleName,
): Promise<Invited> {
  const roleId = await roleIdOf(app, who.headers['X-Site-Id'], role);
  const res = await request(app.getHttpServer())
    .post('/invitations')
    .set(who.headers)
    .send({ email, roleId });
  if (res.status !== 201) {
    throw new Error(
      `invite(${email}): expected 201, got ${res.status} ${JSON.stringify(res.body)}`,
    );
  }
  return {
    id: res.body.invitation.id,
    token: res.body.token,
    invitation: res.body.invitation,
  };
}

/** The SHA-256 hex of a link's secret: what the `invitations` table keeps instead of it. */
export const fingerprint = (token: string) =>
  createHash('sha256').update(token).digest('hex');

/** A 400 whose `errors` list has a `field: message` line for this field. */
export function expectFieldError(
  res: { status: number; body: any },
  field: string,
  what = '',
): void {
  const context = `${what} → ${res.status} ${JSON.stringify(res.body)}`;
  if (res.status !== 400) throw new Error(`expected 400: ${context}`);
  const errors: unknown = res.body?.errors;
  if (
    !Array.isArray(errors) ||
    !errors.some((e) => typeof e === 'string' && e.startsWith(`${field}: `))
  ) {
    throw new Error(`expected an error naming "${field}": ${context}`);
  }
}
