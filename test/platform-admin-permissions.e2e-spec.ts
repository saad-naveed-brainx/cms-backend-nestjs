import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { Organization, User } from '../src/database/entities/index.js';
import { runCreateSuperAdmin } from '../src/cli/run-create-super-admin.js';
import { PlatformAdminService } from '../src/platform-admin/platform-admin.service.js';
import { ProvisioningService } from '../src/provisioning/provisioning.service.js';
import { createTestApp } from './support/app.js';
import { resetDatabase } from './support/database.js';
import { newClient, roleIdOf, type Client } from './support/invitations.js';
import { newSuperAdmin, type SuperAdmin } from './support/platform-admin.js';
import { seedMembership } from './support/seed.js';
import { rowCounts } from './support/tenant.js';

/**
 * Platform admin T6: who may use the platform routes (and who may not), what the super admin cannot
 * reach, that no ordinary person makes an organization any more, and that the owner's own flows still
 * work. Real Postgres, real sign-ins and routes, nothing mocked.
 */

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let app: INestApplication;
let dataSource: DataSource;
let ops: SuperAdmin;
const api = () => request(app.getHttpServer());

beforeAll(async () => {
  ({ app, dataSource } = await createTestApp());
  await app.listen(0, '127.0.0.1');
});
beforeEach(async () => {
  await resetDatabase(dataSource);
  ops = await newSuperAdmin(app);
});
afterAll(async () => {
  await app.close();
});

const person = (prefix: string) =>
  newClient(app, { prefix, adminName: prefix, siteName: `${prefix} Cafe` });
const organizationOf = async (client: Client) =>
  (
    await dataSource.query(`SELECT organization_id FROM sites WHERE id = $1`, [
      client.siteId,
    ])
  )[0].organization_id as string;
const bearer = (client: Client) => ({
  Authorization: client.headers.Authorization,
});

/** Every `/platform/...` route the running app declares, as `METHOD /path`. */
function platformRoutes(): string[] {
  const router =
    (app.getHttpAdapter().getInstance() as any).router ??
    (app.getHttpAdapter().getInstance() as any)._router;
  const found: string[] = [];
  for (const layer of router.stack as any[]) {
    const route = layer.route;
    if (!route || !String(route.path).startsWith('/platform')) continue;
    for (const method of Object.keys(route.methods)) {
      found.push(`${method.toUpperCase()} ${route.path}`);
    }
  }
  return found.sort();
}

const ID = '0198f2a0-0000-7000-8000-0000000000aa';
/** One valid-looking request for each platform route, keyed as the scan names them. */
const CALLS: Record<string, (organizationId: string) => request.Test> = {
  'GET /platform/organizations': () => api().get('/platform/organizations'),
  'POST /platform/organizations': () =>
    api()
      .post('/platform/organizations')
      .send({ name: 'Sneaky', ownerEmail: 'sneaky@x.test', ownerName: 'S' }),
  'POST /platform/organizations/:id/suspend': (id) =>
    api().post(`/platform/organizations/${id}/suspend`),
  'POST /platform/organizations/:id/reactivate': (id) =>
    api().post(`/platform/organizations/${id}/reactivate`),
  'POST /platform/organizations/:id/owner': (id) =>
    api()
      .post(`/platform/organizations/${id}/owner`)
      .send({ ownerEmail: 'sneaky@x.test', ownerName: 'S' }),
  'DELETE /platform/organizations/:id': (id) =>
    api()
      .delete(`/platform/organizations/${id}`)
      .send({ confirmName: 'anything' }),
};

describe('the platform routes are closed to everyone but a super admin', () => {
  it('[UC-PA-26] the table of platform routes is exactly what the app declares', () => {
    expect(platformRoutes()).toEqual(Object.keys(CALLS).sort());
  });

  it('[UC-PA-26] no token is a 401; an owner, a member and a revoked super admin are a 403; nothing changes', async () => {
    const olga = await person('olga');
    const pat = await person('pat');
    const organizationId = await organizationOf(olga);
    // Pat is only an Editor on Olga's website.
    const patUser = await dataSource
      .getRepository(User)
      .findOneByOrFail({ id: pat.userId });
    await seedMembership(dataSource, {
      siteId: olga.siteId,
      userId: patUser.id,
      roleId: await roleIdOf(app, olga.siteId, 'Editor'),
    });
    const revoked = await newSuperAdmin(app, 'gone');
    await runCreateSuperAdmin(
      ['--email', revoked.email, '--revoke'],
      {},
      { out: () => {}, err: () => {} },
      async () => ({
        platformAdmin: app.get(PlatformAdminService),
        close: async () => {},
      }),
    );
    const before = await rowCounts(dataSource);

    for (const [key, call] of Object.entries(CALLS)) {
      expect((await call(organizationId)).status, `${key}: no sign-in`).toBe(
        401,
      );
      for (const [who, headers] of [
        ['the owner', bearer(olga)],
        ['a member', bearer(pat)],
        ['a revoked super admin', revoked.headers],
      ] as const) {
        const res = await call(organizationId).set(headers);
        expect(res.status, `${key}: ${who}`).toBe(403);
      }
    }

    expect(await rowCounts(dataSource)).toEqual(before);
  });

  it('[UC-PA-31] an owner cannot suspend, hand over or delete even their own organization', async () => {
    const olga = await person('olga');
    const organizationId = await organizationOf(olga);

    await api()
      .post(`/platform/organizations/${organizationId}/suspend`)
      .set(bearer(olga))
      .expect(403);
    await api()
      .delete(`/platform/organizations/${organizationId}`)
      .set(bearer(olga))
      .send({ confirmName: 'olga Cafe Ltd' })
      .expect(403);

    const row = await dataSource
      .getRepository(Organization)
      .findOneByOrFail({ id: organizationId });
    expect(row.suspendedAt).toBeNull();
    expect(row.ownerId).toBe(olga.userId);
  });
});

describe('what the super admin cannot reach', () => {
  it('[UC-PA-28] content, members, media, appearance and invitations of an organization are a 403 to them, as to any stranger', async () => {
    const olga = await person('olga');
    const asOps = { ...ops.headers, 'X-Site-Id': olga.siteId };

    for (const attempt of [
      api().get('/content').set(asOps),
      api()
        .post('/content')
        .set(asOps)
        .send({ type: 'page', title: 'x', slug: 'x' }),
      api().get('/members').set(asOps),
      api().get('/media').set(asOps),
      api().get('/appearance').set(asOps),
      api().patch('/appearance').set(asOps).send({ name: 'Hijack' }),
      api().get('/content-types').set(asOps),
      api()
        .post('/invitations')
        .set(asOps)
        .send({ email: 'a@b.test', roleId: ID }),
    ]) {
      const res = await attempt;
      expect(res.status, `${res.request.method} ${res.request.url}`).toBe(403);
    }
    const stored = await dataSource.query(
      `SELECT name FROM sites WHERE id = $1`,
      [olga.siteId],
    );
    expect(stored[0].name).toBe('olga Cafe');
    // And the platform's own list tells nothing of what is inside.
    const list = await api()
      .get('/platform/organizations')
      .set(ops.headers)
      .expect(200);
    expect(JSON.stringify(list.body)).not.toMatch(
      /blocks|slug|hostname|password/i,
    );
  });

  it("[UC-PA-29] an organization's team is not theirs to read: 404, as for any non-owner", async () => {
    const olga = await person('olga');
    const organizationId = await organizationOf(olga);

    const res = await api()
      .get(`/organizations/${organizationId}/team`)
      .set(ops.headers);

    expect(res.status).toBe(404);
  });
});

describe('nobody makes an organization of their own any more', () => {
  it('[UC-PA-30] POST /organizations is a 404 for an owner, a member and a person with no website, and creates nothing', async () => {
    const olga = await person('olga');
    const lone = await dataSource
      .getRepository(User)
      .save({ email: 'lone@x.test', name: 'Lone', passwordHash: 'x' });
    expect(lone.id).toBeDefined();
    const before = await rowCounts(dataSource);

    for (const headers of [bearer(olga), ops.headers]) {
      const res = await api()
        .post('/organizations')
        .set(headers)
        .send({ name: 'Mine' });
      expect(res.status).toBe(404);
    }

    expect(await rowCounts(dataSource)).toEqual(before);
    // The list of what one owns is still there.
    const owned = await api()
      .get('/organizations')
      .set(bearer(olga))
      .expect(200);
    expect(owned.body.items).toHaveLength(1);
  });
});

describe('what owners still do', () => {
  it('[UC-PA-37] an owner of an active organization adds a website, reads the team and deletes a website, as before', async () => {
    const olga = await person('olga');
    const organizationId = await organizationOf(olga);
    const auth = bearer(olga);

    const added = await api()
      .post('/sites')
      .set(auth)
      .send({ name: 'Second', hostnames: ['second.olga.test'] })
      .expect(201);
    const team = await api()
      .get(`/organizations/${organizationId}/team`)
      .set(auth)
      .expect(200);
    expect(team.body.websites).toHaveLength(2);
    await api().delete(`/sites/${added.body.site.id}`).set(auth).expect(204);
    expect(
      (
        await api()
          .get(`/organizations/${organizationId}/team`)
          .set(auth)
          .expect(200)
      ).body.websites,
    ).toHaveLength(1);
  });

  it('[UC-PA-38] the seed command still makes an organization, an owner and a website without any route', async () => {
    const made = await app.get(ProvisioningService).provisionTenant({
      organizationName: 'Seeded Ltd',
      siteName: 'Seeded Site',
      hostnames: ['seeded.test'],
      admin: {
        email: 'seed@seeded.test',
        name: 'Seed',
        password: 'seeded-password-123',
      },
    });

    expect(made.organization.name).toBe('Seeded Ltd');
    const login = await api()
      .post('/auth/login')
      .send({ email: 'seed@seeded.test', password: 'seeded-password-123' })
      .expect(200);
    expect(login.body.organizations).toEqual([
      {
        id: made.organization.id,
        name: 'Seeded Ltd',
        ownsOrganization: true,
        suspended: false,
      },
    ]);
  });
});
