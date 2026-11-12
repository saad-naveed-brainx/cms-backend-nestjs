import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import type { RoleName } from '../src/auth/roles.js';
import { User } from '../src/database/entities/index.js';
import { SiteResolver } from '../src/sites/site-resolver.service.js';
import { WebsiteCache } from '../src/website/website-cache.service.js';
import { createTestApp } from './support/app.js';
import { resetDatabase } from './support/database.js';
import { newClient, roleIdOf, type Client } from './support/invitations.js';
import { newSuperAdmin, type SuperAdmin } from './support/platform-admin.js';
import { seedMembership } from './support/seed.js';
import { signTestToken } from './support/tokens.js';

/**
 * Platform admin T4: suspending an organization makes its websites unavailable to visitors and
 * read-only to members, clears every cache, and reactivating brings it all back. Real Postgres, real
 * sign-ins and routes, nothing mocked.
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
  // The API remembers host answers for a minute, and every test here reuses the same hosts.
  app.get(SiteResolver).invalidateAll();
  ops = await newSuperAdmin(app);
});
afterAll(async () => {
  await app.close();
  vi.restoreAllMocks();
});

const organizationOf = async (client: Client) =>
  (
    await dataSource.query(`SELECT organization_id FROM sites WHERE id = $1`, [
      client.siteId,
    ])
  )[0].organization_id as string;
const suspend = (id: string) =>
  api().post(`/platform/organizations/${id}/suspend`).set(ops.headers);
const reactivate = (id: string) =>
  api().post(`/platform/organizations/${id}/reactivate`).set(ops.headers);
const site = (host: string) =>
  api().get('/public/site').query({ host, path: '/' });
const olga = () =>
  newClient(app, { prefix: 'olga', adminName: 'Olga', siteName: 'Olga Cafe' });
const maple = () =>
  newClient(app, {
    prefix: 'maple',
    adminName: 'Max',
    siteName: 'Maple Books',
  });

/** A member with this role on the site, who signs requests with a token made by hand. */
async function memberWith(client: Client, role: RoleName) {
  const user = await dataSource.getRepository(User).save({
    email: `${role.toLowerCase()}@${client.siteId.slice(0, 8)}.test`,
    name: role,
    passwordHash: 'x',
  });
  await seedMembership(dataSource, {
    siteId: client.siteId,
    userId: user.id,
    roleId: await roleIdOf(app, client.siteId, role),
  });
  const token = await signTestToken({ sub: user.id });
  return { Authorization: `Bearer ${token}`, 'X-Site-Id': client.siteId };
}

const contentRows = () =>
  dataSource.query(
    `SELECT id, title, status, updated_at FROM content ORDER BY id`,
  );

describe('suspend and reactivate', () => {
  it('[UC-PA-06] visitors get a 503 "unavailable", members can look but not change, and reactivating brings it all back unchanged', async () => {
    const client = await olga();
    const organizationId = await organizationOf(client);
    await site('olga.test').expect(200); // remembered by the API now
    const pageId = (await dataSource.query(`SELECT id FROM content LIMIT 1`))[0]
      .id;
    const preview = await api()
      .post(`/content/${pageId}/preview`)
      .set(client.headers)
      .expect(200);
    const before = await contentRows();

    const res = await suspend(organizationId);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: organizationId, status: 'suspended' });
    const visitor = await site('olga.test');
    expect(visitor.status).toBe(503);
    expect(visitor.body).toMatchObject({
      code: 'site_suspended',
      message: 'This site is unavailable',
    });
    expect(
      (
        await api()
          .get('/public/preview')
          .query({ host: 'olga.test', token: preview.body.token })
      ).status,
    ).toBe(503);
    const write = await api()
      .post('/content')
      .set(client.headers)
      .send({ type: 'page', title: 'New page', slug: 'new-page' });
    expect(write.status).toBe(403);
    expect(write.body).toMatchObject({ code: 'organization_suspended' });
    await api().get('/content').set(client.headers).expect(200);
    const list = await api()
      .get('/platform/organizations')
      .set(ops.headers)
      .expect(200);
    expect(list.body.items[0].status).toBe('suspended');
    expect(await contentRows()).toEqual(before);

    await reactivate(organizationId).expect(200);

    await site('olga.test').expect(200);
    await api()
      .post('/content')
      .set(client.headers)
      .send({ type: 'page', title: 'New page', slug: 'new-page' })
      .expect(201);
    expect((await contentRows()).slice(0, before.length)).toEqual(
      before.map((row: { id: string }) =>
        expect.objectContaining({ id: row.id }),
      ),
    );
    expect(
      (await api().get('/platform/organizations').set(ops.headers)).body
        .items[0].status,
    ).toBe('active');
  });

  it('[UC-PA-06] suspending twice changes nothing, and so does reactivating an active one', async () => {
    const organizationId = await organizationOf(await olga());

    await suspend(organizationId).expect(200);
    const first = (
      await dataSource.query(`SELECT suspended_at FROM organizations`)
    )[0];
    await suspend(organizationId).expect(200);
    const second = (
      await dataSource.query(`SELECT suspended_at FROM organizations`)
    )[0];
    await reactivate(organizationId).expect(200);
    await reactivate(organizationId).expect(200);

    expect(second.suspended_at).toEqual(first.suspended_at);
    expect(
      (await dataSource.query(`SELECT suspended_at FROM organizations`))[0]
        .suspended_at,
    ).toBeNull();
  });

  it('[UC-PA-06] works for an organization with no websites', async () => {
    const created = await api()
      .post('/platform/organizations')
      .set(ops.headers)
      .send({ name: 'Empty', ownerEmail: 'e@x.test', ownerName: 'E' })
      .expect(201);

    await suspend(created.body.id).expect(200);
    await reactivate(created.body.id).expect(200);
  });
});

describe('what a suspended organization refuses', () => {
  it("[UC-PA-33] refuses every role's writes with 403 organization_suspended, and still lets each read and preview", async () => {
    const client = await olga();
    await suspend(await organizationOf(client)).expect(200);
    const page = (await dataSource.query(`SELECT id FROM content LIMIT 1`))[0]
      .id as string;
    const people = {
      Administrator: client.headers,
      Editor: await memberWith(client, 'Editor'),
      Author: await memberWith(client, 'Author'),
      Contributor: await memberWith(client, 'Contributor'),
    };

    for (const [role, headers] of Object.entries(people)) {
      const attempts = [
        api()
          .post('/content')
          .set(headers)
          .send({ type: 'page', title: 'x', slug: 'x' }),
        api().patch(`/content/${page}`).set(headers).send({ title: 'y' }),
        api().post(`/content/${page}/publish`).set(headers),
        api().patch('/appearance').set(headers).send({ name: 'Renamed' }),
        api()
          .post('/invitations')
          .set(headers)
          .send({ email: 'a@b.test', roleId: crypto.randomUUID() }),
      ];
      for (const [index, attempt] of attempts.entries()) {
        const res = await attempt;
        expect(
          res.status,
          `${role} ${res.request.method} ${res.request.url}`,
        ).toBe(403);
        // Creating a page is allowed to all four roles, so the reason shown is the suspension; the
        // other writes may already be refused for lack of a permission, which is a 403 too.
        if (index === 0 || role === 'Administrator') {
          expect(res.body.code, role).toBe('organization_suspended');
        }
      }
      await api().get('/content').set(headers).expect(200);
      await api().post(`/content/${page}/preview`).set(headers).expect(200);
    }
  });

  it('[UC-PA-33] the owner cannot add a website to it either', async () => {
    const client = await olga();
    await suspend(await organizationOf(client)).expect(200);

    const res = await api()
      .post('/sites')
      .set({ Authorization: client.headers.Authorization })
      .send({ name: 'Another', hostnames: ['another.test'] });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('organization_suspended');
    expect(
      await dataSource.query(`SELECT 1 FROM sites WHERE name = 'Another'`),
    ).toEqual([]);
  });
});

describe('caches', () => {
  it("[UC-PA-34] one organization suspended leaves the other's host serving, and each change tells the website to forget the right addresses", async () => {
    const a = await olga();
    const b = await maple();
    const forget = vi
      .spyOn(app.get(WebsiteCache), 'forgetHosts')
      .mockResolvedValue();
    await site('olga.test').expect(200);
    await site('maple.test').expect(200);

    await suspend(await organizationOf(a)).expect(200);

    expect(forget).toHaveBeenLastCalledWith(['olga.test'], expect.any(String));
    expect((await site('olga.test')).status).toBe(503);
    expect((await site('maple.test')).status).toBe(200);
    await api().get('/content').set(b.headers).expect(200);

    await reactivate(await organizationOf(a)).expect(200);

    expect(forget).toHaveBeenLastCalledWith(['olga.test'], expect.any(String));
    expect((await site('olga.test')).status).toBe(200);
    expect((await site('maple.test')).status).toBe(200);
    expect(forget).toHaveBeenCalledTimes(2);
  });

  it('[UC-PA-34] every address of the website is forgotten, not only the first', async () => {
    const a = await olga();
    await dataSource.query(
      `INSERT INTO hostnames (site_id, hostname, is_primary) VALUES ($1, 'www.olga.test', false)`,
      [a.siteId],
    );
    const forget = vi
      .spyOn(app.get(WebsiteCache), 'forgetHosts')
      .mockResolvedValue();

    await suspend(await organizationOf(a)).expect(200);

    const [hosts] = forget.mock.calls.at(-1)!;
    expect([...hosts].sort()).toEqual(['olga.test', 'www.olga.test']);
    expect((await site('www.olga.test')).status).toBe(503);
  });

  it('[UC-PA-39] an active organization serves as before, and says so on the host lookup', async () => {
    await olga();

    const page = await site('olga.test');
    const resolved = await api()
      .get('/sites/resolve')
      .query({ host: 'olga.test' });

    expect(page.status).toBe(200);
    expect(page.body.kind).toBe('page');
    expect(resolved.body.suspended).toBe(false);
  });
});
