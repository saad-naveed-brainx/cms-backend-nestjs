import { createHash } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import {
  Organization,
  OrganizationInvitation,
  User,
} from '../src/database/entities/index.js';
import { runCreateSuperAdmin } from '../src/cli/run-create-super-admin.js';
import { PlatformAdminService } from '../src/platform-admin/platform-admin.service.js';
import { createTestApp } from './support/app.js';
import { resetDatabase } from './support/database.js';
import { newClient } from './support/invitations.js';
import { newSuperAdmin, type SuperAdmin } from './support/platform-admin.js';
import { rowCounts } from './support/tenant.js';

/**
 * Platform admin T2: the super admin lists organizations and creates one for an owner by email.
 * Real Postgres, real sign-ins, nothing mocked.
 */

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let app: INestApplication;
let dataSource: DataSource;
let ops: SuperAdmin;
const api = () => request(app.getHttpServer());

beforeAll(async () => {
  ({ app, dataSource } = await createTestApp());
});
beforeEach(async () => {
  await resetDatabase(dataSource);
  ops = await newSuperAdmin(app);
});
afterAll(async () => {
  await app.close();
});

const create = (body: Record<string, unknown>, headers = ops.headers) =>
  api().post('/platform/organizations').set(headers).send(body);
const list = () => api().get('/platform/organizations').set(ops.headers);
const sha256 = (text: string) =>
  createHash('sha256').update(text).digest('hex');

describe('creating an organization for an owner with an account', () => {
  it('[UC-PA-03] makes that person the owner at once, with no link, and the next sign-in lists it', async () => {
    const olga = await newClient(app, {
      prefix: 'olga',
      adminName: 'Olga',
      siteName: 'Olga Cafe',
    });

    const res = await create({
      name: 'Acme',
      ownerEmail: 'olga-owner@olga.test',
    });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      id: expect.any(String),
      name: 'Acme',
      owner: { id: olga.userId, email: 'olga-owner@olga.test', name: 'Olga' },
      ownerInvitation: null,
    });
    const row = await dataSource
      .getRepository(Organization)
      .findOneByOrFail({ id: res.body.id });
    expect(row.ownerId).toBe(olga.userId);
    expect(row.suspendedAt).toBeNull();
    const login = await api()
      .post('/auth/login')
      .send({ email: 'olga-owner@olga.test', password: 'olga-owner-password' })
      .expect(200);
    expect(login.body.organizations).toContainEqual({
      id: res.body.id,
      name: 'Acme',
      ownsOrganization: true,
      suspended: false,
    });
  });

  it('[UC-PA-09] finds the account whatever the letter case or spaces of the email, and makes no second one', async () => {
    const olga = await newClient(app, {
      prefix: 'olga',
      adminName: 'Olga',
      siteName: 'Olga Cafe',
    });
    const before = await rowCounts(dataSource);

    const res = await create({
      name: 'Case Ltd',
      ownerEmail: '  Olga-Owner@OLGA.test ',
    });

    expect(res.status).toBe(201);
    expect(res.body.owner.id).toBe(olga.userId);
    expect(res.body.ownerInvitation).toBeNull();
    const after = await rowCounts(dataSource);
    expect(after.users).toBe(before.users);
    expect(after.organization_invitations).toBe(0);
  });

  it('[UC-PA-09] ignores an owner name for an existing account: they keep their own', async () => {
    const olga = await newClient(app, {
      prefix: 'olga',
      adminName: 'Olga',
      siteName: 'Olga Cafe',
    });

    await create({
      name: 'Name Ltd',
      ownerEmail: 'olga-owner@olga.test',
      ownerName: 'Someone Else',
    }).expect(201);

    const user = await dataSource
      .getRepository(User)
      .findOneByOrFail({ id: olga.userId });
    expect(user.name).toBe('Olga');
  });
});

describe('creating an organization for a brand-new owner', () => {
  it('[UC-PA-04] waits for the owner: one link shown once, no account yet, only its fingerprint stored', async () => {
    const res = await create({
      name: 'Beta',
      ownerEmail: 'new@x.test',
      ownerName: 'Nia',
    });

    expect(res.status).toBe(201);
    expect(res.body.owner).toBeNull();
    const { token, email, name, expiresAt } = res.body.ownerInvitation;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect({ email, name }).toEqual({ email: 'new@x.test', name: 'Nia' });
    const days = (Date.parse(expiresAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThanOrEqual(7);

    expect(
      await dataSource.getRepository(User).countBy({ email: 'new@x.test' }),
    ).toBe(0);
    const organization = await dataSource
      .getRepository(Organization)
      .findOneByOrFail({ id: res.body.id });
    expect(organization.ownerId).toBeNull();
    const invitation = await dataSource
      .getRepository(OrganizationInvitation)
      .findOneByOrFail({ organizationId: res.body.id });
    expect(invitation.tokenHash).toBe(sha256(token));
    // The secret is nowhere in the database.
    const everything = JSON.stringify(
      await dataSource.query('SELECT * FROM organization_invitations'),
    );
    expect(everything).not.toContain(token);
    expect(invitation.invitedBy).not.toBeNull();
  });

  it('[UC-PA-04] shows in the list as awaiting its owner', async () => {
    const res = await create({
      name: 'Beta',
      ownerEmail: 'new@x.test',
      ownerName: 'Nia',
    }).expect(201);

    const listed = await list().expect(200);

    expect(listed.body.items).toEqual([
      {
        id: res.body.id,
        name: 'Beta',
        status: 'awaiting_owner',
        owner: null,
        pendingOwnerEmail: 'new@x.test',
        websites: 0,
        createdAt: expect.any(String),
      },
    ]);
  });

  it("[UC-PA-20] needs the new owner's name, and makes nothing without it", async () => {
    const before = await rowCounts(dataSource);

    const res = await create({ name: 'Beta', ownerEmail: 'new@x.test' });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('ownerName');
    expect(await rowCounts(dataSource)).toEqual(before);
  });
});

describe('the list', () => {
  it('[UC-PA-03] shows owner, website count and status for each, by name', async () => {
    const olga = await newClient(app, {
      prefix: 'olga',
      adminName: 'Olga',
      siteName: 'Olga Cafe',
    });
    const acme = await create({
      name: 'Acme',
      ownerEmail: 'olga-owner@olga.test',
    }).expect(201);
    await dataSource
      .getRepository(Organization)
      .update({ id: acme.body.id }, { suspendedAt: new Date() });

    const listed = await list().expect(200);

    expect(listed.body.items.map((o: { name: string }) => o.name)).toEqual([
      'Acme',
      'Olga Cafe Ltd',
    ]);
    const [suspended, active] = listed.body.items;
    expect(suspended).toMatchObject({
      status: 'suspended',
      websites: 0,
      owner: { id: olga.userId },
    });
    expect(active).toMatchObject({
      status: 'active',
      websites: 1,
      owner: { id: olga.userId, email: 'olga-owner@olga.test', name: 'Olga' },
      pendingOwnerEmail: null,
    });
  });

  it('[UC-PA-03] is empty when there is none', async () => {
    const listed = await list().expect(200);
    expect(listed.body).toEqual({ items: [] });
  });

  it('[UC-PA-10] lets two organizations share a name, each with its owner so they can be told apart', async () => {
    await create({
      name: 'Acme',
      ownerEmail: 'a@x.test',
      ownerName: 'Ann',
    }).expect(201);
    await create({
      name: 'Acme',
      ownerEmail: 'b@x.test',
      ownerName: 'Bob',
    }).expect(201);

    const listed = await list().expect(200);

    expect(listed.body.items).toHaveLength(2);
    expect(
      listed.body.items
        .map((o: { pendingOwnerEmail: string }) => o.pendingOwnerEmail)
        .sort(),
    ).toEqual(['a@x.test', 'b@x.test']);
  });
});

describe('what the super admin may not send', () => {
  const owner = { ownerEmail: 'new@x.test', ownerName: 'Nia' };

  it('[UC-PA-17] refuses a blank name, a name over 100 characters and a missing one, and makes nothing', async () => {
    const before = await rowCounts(dataSource);
    for (const name of ['', '   ', 'x'.repeat(101), undefined]) {
      const res = await create({ name, ...owner });
      expect(res.status, JSON.stringify(name)).toBe(400);
      expect(JSON.stringify(res.body)).toContain('name');
    }
    expect(await rowCounts(dataSource)).toEqual(before);
  });

  it('[UC-PA-17] accepts exactly 100 characters, trimmed', async () => {
    const res = await create({ name: `  ${'x'.repeat(100)}  `, ...owner });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('x'.repeat(100));
  });

  it('[UC-PA-17] refuses a field it does not know, such as an owner id', async () => {
    const res = await create({
      name: 'Acme',
      ...owner,
      ownerId: crypto.randomUUID(),
    });
    expect(res.status).toBe(400);
  });

  it('[UC-PA-18] a NUL character is a 400, not a 500, in the name and in the owner name', async () => {
    const before = await rowCounts(dataSource);

    const inName = await create({ name: 'A\u0000B', ...owner });
    const inOwner = await create({
      name: 'Acme',
      ownerEmail: 'new@x.test',
      ownerName: 'N\u0000ia',
    });

    expect(inName.status).toBe(400);
    expect(inOwner.status).toBe(400);
    expect(await rowCounts(dataSource)).toEqual(before);
  });

  it('[UC-PA-18] HTML in a name is kept as text, exactly as typed', async () => {
    const name = '<script>alert(1)</script> & Co';
    const res = await create({ name, ...owner }).expect(201);

    const listed = await list().expect(200);

    expect(res.body.name).toBe(name);
    expect(listed.body.items[0].name).toBe(name);
  });

  it('[UC-PA-19] refuses an empty email, one with no @, and one over 254 characters', async () => {
    const before = await rowCounts(dataSource);
    for (const ownerEmail of [
      '',
      '   ',
      'nobody',
      'a@',
      `${'a'.repeat(250)}@x.test`,
      undefined,
    ]) {
      const res = await create({ name: 'Acme', ownerEmail, ownerName: 'Nia' });
      expect(res.status, String(ownerEmail)).toBe(400);
      expect(JSON.stringify(res.body)).toContain('ownerEmail');
    }
    expect(await rowCounts(dataSource)).toEqual(before);
  });
});

describe('who may use the platform routes', () => {
  it('[UC-PA-26] answers 401 with no sign-in and 403 to a person who is not a super admin', async () => {
    const olga = await newClient(app, {
      prefix: 'olga',
      adminName: 'Olga',
      siteName: 'Olga Cafe',
    });
    const before = await rowCounts(dataSource);
    const body = { name: 'Sneaky', ownerEmail: 'olga-owner@olga.test' };

    await api().get('/platform/organizations').expect(401);
    await api().post('/platform/organizations').send(body).expect(401);
    await api()
      .get('/platform/organizations')
      .set({ Authorization: olga.headers.Authorization })
      .expect(403);
    await api()
      .post('/platform/organizations')
      .set({ Authorization: olga.headers.Authorization })
      .send(body)
      .expect(403);

    expect(await rowCounts(dataSource)).toEqual(before);
  });

  it('[UC-PA-27] a revoked super admin is refused with the very same token', async () => {
    await list().expect(200);

    await runCreateSuperAdmin(
      ['--email', ops.email, '--revoke'],
      {},
      { out: () => {}, err: () => {} },
      async () => ({
        platformAdmin: app.get(PlatformAdminService),
        close: async () => {},
      }),
    );

    await list().expect(403);
    await create({
      name: 'Late',
      ownerEmail: 'a@x.test',
      ownerName: 'A',
    }).expect(403);
  });
});
