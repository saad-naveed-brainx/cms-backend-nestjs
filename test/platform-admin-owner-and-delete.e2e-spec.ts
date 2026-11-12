import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import {
  Organization,
  OrganizationInvitation,
  User,
} from '../src/database/entities/index.js';
import { WebsiteCache } from '../src/website/website-cache.service.js';
import { SiteResolver } from '../src/sites/site-resolver.service.js';
import { createTestApp } from './support/app.js';
import { resetDatabase } from './support/database.js';
import { newClient, type Client } from './support/invitations.js';
import { newSuperAdmin, type SuperAdmin } from './support/platform-admin.js';
import { rowCounts } from './support/tenant.js';

/**
 * Platform admin T5: the super admin hands an organization to another owner, and deletes one for good.
 * Real Postgres, real sign-ins and routes, nothing mocked.
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
  app.get(SiteResolver).invalidateAll();
  ops = await newSuperAdmin(app);
});
afterAll(async () => {
  await app.close();
  vi.restoreAllMocks();
});

const person = (prefix: string) =>
  newClient(app, { prefix, adminName: prefix, siteName: `${prefix} Cafe` });
const organizationOf = async (client: Client) =>
  (
    await dataSource.query(`SELECT organization_id FROM sites WHERE id = $1`, [
      client.siteId,
    ])
  )[0].organization_id as string;
const changeOwner = (id: string, body: Record<string, unknown>) =>
  api().post(`/platform/organizations/${id}/owner`).set(ops.headers).send(body);
const remove = (id: string, body: Record<string, unknown> = {}) =>
  api().delete(`/platform/organizations/${id}`).set(ops.headers).send(body);
const roleOn = async (siteId: string, email: string) =>
  (
    await dataSource.query(
      `SELECT r.name FROM site_members m JOIN roles r ON r.site_id = m.site_id AND r.id = m.role_id
         JOIN users u ON u.id = m.user_id WHERE m.site_id = $1 AND u.email = $2`,
      [siteId, email],
    )
  )[0]?.name as string | undefined;
const sitesOf = async (organizationId: string) =>
  (await dataSource.query(
    `SELECT id, name FROM sites WHERE organization_id = $1 ORDER BY name`,
    [organizationId],
  )) as {
    id: string;
    name: string;
  }[];

/** Olga's organization with two websites, and Pat, who has an account of their own. */
async function acme() {
  const olga = await person('olga');
  const pat = await person('pat');
  await api()
    .post('/sites')
    .set({ Authorization: olga.headers.Authorization })
    .send({ name: 'Olga Second', hostnames: ['olga2.test'] })
    .expect(201);
  const organizationId = await organizationOf(olga);
  const [w1, w2] = await sitesOf(organizationId);
  return { olga, pat, organizationId, w1, w2 };
}

describe('changing the owner to an existing account', () => {
  it('[UC-PA-07] makes them owner and Administrator on every website; the old owner stays an Administrator but is no longer the owner', async () => {
    const { olga, organizationId, w1, w2 } = await acme();

    const res = await changeOwner(organizationId, {
      ownerEmail: 'pat-owner@pat.test',
    });

    expect(res.status).toBe(200);
    expect(res.body.owner).toMatchObject({ email: 'pat-owner@pat.test' });
    expect(res.body.ownerInvitation).toBeNull();
    const org = await dataSource
      .getRepository(Organization)
      .findOneByOrFail({ id: organizationId });
    expect(org.ownerId).toBe(res.body.owner.id);
    for (const site of [w1, w2]) {
      expect(await roleOn(site.id, 'pat-owner@pat.test')).toBe('Administrator');
      expect(await roleOn(site.id, 'olga-owner@olga.test')).toBe(
        'Administrator',
      );
    }
    const auth = { Authorization: olga.headers.Authorization };
    await api()
      .get(`/organizations/${organizationId}/team`)
      .set(auth)
      .expect(403);
    await api().delete(`/sites/${w1.id}`).set(auth).expect(403);
    const patLogin = await api()
      .post('/auth/login')
      .send({ email: 'pat-owner@pat.test', password: 'pat-owner-password' })
      .expect(200);
    expect(patLogin.body.organizations).toContainEqual({
      id: organizationId,
      name: 'olga Cafe Ltd',
      ownsOrganization: true,
      suspended: false,
    });
  });

  it('[UC-PA-15] with "remove old owner", the old owner has no role on any website and no longer sees the organization, but keeps the account', async () => {
    const { olga, organizationId, w1, w2 } = await acme();

    await changeOwner(organizationId, {
      ownerEmail: 'pat-owner@pat.test',
      removeOld: true,
    }).expect(200);

    for (const site of [w1, w2]) {
      expect(await roleOn(site.id, 'olga-owner@olga.test')).toBeUndefined();
    }
    const login = await api()
      .post('/auth/login')
      .send({ email: 'olga-owner@olga.test', password: 'olga-owner-password' })
      .expect(200);
    expect(
      login.body.organizations.map((o: { id: string }) => o.id),
    ).not.toContain(organizationId);
    expect(
      login.body.memberships.map((m: { site: { id: string } }) => m.site.id),
    ).not.toContain(w1.id);
    expect(
      await dataSource.getRepository(User).countBy({ id: olga.userId }),
    ).toBe(1);
  });

  it('[UC-PA-07] the same person again changes nothing and still answers 200', async () => {
    const { organizationId } = await acme();

    await changeOwner(organizationId, {
      ownerEmail: 'olga-owner@olga.test',
    }).expect(200);
    await changeOwner(organizationId, {
      ownerEmail: 'olga-owner@olga.test',
      removeOld: true,
    }).expect(200);

    const login = await api()
      .post('/auth/login')
      .send({ email: 'olga-owner@olga.test', password: 'olga-owner-password' })
      .expect(200);
    expect(login.body.organizations.map((o: { id: string }) => o.id)).toContain(
      organizationId,
    );
    expect(
      await roleOn(
        (await sitesOf(organizationId))[0].id,
        'olga-owner@olga.test',
      ),
    ).toBe('Administrator');
  });

  it('[UC-PA-07] an owner who was only a lower-role member of its websites is raised to Administrator', async () => {
    const { pat, organizationId, w1 } = await acme();
    await dataSource.query(
      `INSERT INTO site_members (site_id, user_id, role_id)
       SELECT $1, $2, id FROM roles WHERE site_id = $1 AND name = 'Viewer'`,
      [w1.id, pat.userId],
    );

    await changeOwner(organizationId, {
      ownerEmail: 'pat-owner@pat.test',
    }).expect(200);

    expect(await roleOn(w1.id, 'pat-owner@pat.test')).toBe('Administrator');
  });
});

describe('changing the owner to a new person', () => {
  it('[UC-PA-07] leaves the owner as it is until the link is used, then hands over', async () => {
    const { organizationId, w1, w2 } = await acme();

    const res = await changeOwner(organizationId, {
      ownerEmail: 'nia@x.test',
      ownerName: 'Nia',
    });

    expect(res.status).toBe(200);
    expect(res.body.owner).toBeNull();
    const { token } = res.body.ownerInvitation;
    const org = await dataSource
      .getRepository(Organization)
      .findOneByOrFail({ id: organizationId });
    expect(org.ownerId).not.toBeNull();
    const list = await api()
      .get('/platform/organizations')
      .set(ops.headers)
      .expect(200);
    expect(list.body.items[0]).toMatchObject({
      status: 'active',
      pendingOwnerEmail: 'nia@x.test',
    });

    await api()
      .post('/invitations/accept')
      .send({ token, password: 'nia-owner-password', name: 'Nia' })
      .expect(200);

    const after = await dataSource
      .getRepository(Organization)
      .findOneByOrFail({ id: organizationId });
    expect(after.ownerId).not.toBe(org.ownerId);
    for (const site of [w1, w2]) {
      expect(await roleOn(site.id, 'nia@x.test')).toBe('Administrator');
      expect(await roleOn(site.id, 'olga-owner@olga.test')).toBe(
        'Administrator',
      );
    }
    expect(await dataSource.getRepository(OrganizationInvitation).count()).toBe(
      0,
    );
  });

  it('[UC-PA-15] "remove old owner" given with a link is applied when the link is used', async () => {
    const { organizationId, w1 } = await acme();
    const res = await changeOwner(organizationId, {
      ownerEmail: 'nia@x.test',
      ownerName: 'Nia',
      removeOld: true,
    }).expect(200);

    expect(await roleOn(w1.id, 'olga-owner@olga.test')).toBe('Administrator');
    await api()
      .post('/invitations/accept')
      .send({
        token: res.body.ownerInvitation.token,
        password: 'nia-owner-password',
        name: 'Nia',
      })
      .expect(200);

    expect(await roleOn(w1.id, 'olga-owner@olga.test')).toBeUndefined();
    expect(await roleOn(w1.id, 'nia@x.test')).toBe('Administrator');
  });

  it('[UC-PA-20] a new person needs a name, and nothing changes without it', async () => {
    const { organizationId } = await acme();
    const before = await rowCounts(dataSource);

    const res = await changeOwner(organizationId, { ownerEmail: 'nia@x.test' });

    expect(res.status).toBe(400);
    expect(await rowCounts(dataSource)).toEqual(before);
  });

  it('[UC-PA-11] works for an organization that has no owner yet, and an existing account then ends the wait', async () => {
    await acme();
    const created = await api()
      .post('/platform/organizations')
      .set(ops.headers)
      .send({ name: 'Beta', ownerEmail: 'nia@x.test', ownerName: 'Nia' })
      .expect(201);

    await changeOwner(created.body.id, {
      ownerEmail: 'pat-owner@pat.test',
    }).expect(200);

    const org = await dataSource
      .getRepository(Organization)
      .findOneByOrFail({ id: created.body.id });
    expect(org.ownerId).not.toBeNull();
    expect(await dataSource.getRepository(OrganizationInvitation).count()).toBe(
      0,
    );
    const old = await api()
      .post('/invitations/lookup')
      .send({ token: created.body.ownerInvitation.token });
    expect(old.status).toBe(404);
  });
});

describe('deleting an organization', () => {
  it('[UC-PA-08] removes the organization, its websites and everything on them, keeps the accounts, and the addresses stop answering', async () => {
    const { olga, pat, organizationId, w1 } = await acme();
    await api()
      .get('/public/site')
      .query({ host: 'olga.test', path: '/' })
      .expect(200);
    const forget = vi
      .spyOn(app.get(WebsiteCache), 'forgetHosts')
      .mockResolvedValue();
    const patSites = await sitesOf(await organizationOf(pat));

    const res = await remove(organizationId, { confirmName: 'olga Cafe Ltd' });

    expect(res.status).toBe(204);
    expect(
      await dataSource
        .getRepository(Organization)
        .countBy({ id: organizationId }),
    ).toBe(0);
    expect(await sitesOf(organizationId)).toEqual([]);
    for (const table of [
      'content',
      'roles',
      'site_members',
      'hostnames',
      'invitations',
    ]) {
      const left = await dataSource.query(
        `SELECT count(*)::int AS n FROM ${table} WHERE site_id = $1`,
        [w1.id],
      );
      expect(left[0].n, table).toBe(0);
    }
    expect(
      await dataSource.getRepository(User).countBy({ id: olga.userId }),
    ).toBe(1);
    expect((await sitesOf(await organizationOf(pat))).map((s) => s.id)).toEqual(
      patSites.map((s) => s.id),
    );
    expect(
      (await api().get('/public/site').query({ host: 'olga.test', path: '/' }))
        .status,
    ).toBe(404);
    expect(
      (await api().get('/public/site').query({ host: 'olga2.test', path: '/' }))
        .status,
    ).toBe(404);
    expect(
      (await api().get('/public/site').query({ host: 'pat.test', path: '/' }))
        .status,
    ).toBe(200);
    const [hosts] = forget.mock.calls.at(-1)!;
    expect([...hosts].sort()).toEqual(['olga.test', 'olga2.test']);
    const olgaLogin = await api()
      .post('/auth/login')
      .send({ email: 'olga-owner@olga.test', password: 'olga-owner-password' })
      .expect(200);
    expect(olgaLogin.body.organizations).toEqual([]);
  });

  it('[UC-PA-08] deletes an organization that waits for its owner, with its link', async () => {
    const created = await api()
      .post('/platform/organizations')
      .set(ops.headers)
      .send({ name: 'Beta', ownerEmail: 'nia@x.test', ownerName: 'Nia' })
      .expect(201);

    await remove(created.body.id, { confirmName: 'Beta' }).expect(204);

    expect(await dataSource.getRepository(OrganizationInvitation).count()).toBe(
      0,
    );
    expect(
      await dataSource
        .getRepository(Organization)
        .countBy({ id: created.body.id }),
    ).toBe(0);
  });

  it('[UC-PA-16] a suspended organization can be deleted and have its owner changed; suspending one with no websites works', async () => {
    const { organizationId } = await acme();
    const empty = await api()
      .post('/platform/organizations')
      .set(ops.headers)
      .send({ name: 'Empty', ownerEmail: 'e@x.test', ownerName: 'E' })
      .expect(201);
    await api()
      .post(`/platform/organizations/${empty.body.id}/suspend`)
      .set(ops.headers)
      .expect(200);
    await api()
      .post(`/platform/organizations/${organizationId}/suspend`)
      .set(ops.headers)
      .expect(200);

    await changeOwner(organizationId, {
      ownerEmail: 'pat-owner@pat.test',
    }).expect(200);
    await remove(organizationId, { confirmName: 'olga Cafe Ltd' }).expect(204);

    expect(
      (await api().get('/public/site').query({ host: 'olga.test', path: '/' }))
        .status,
    ).toBe(404);
    await remove(empty.body.id, { confirmName: 'Empty' }).expect(204);
  });

  it('[UC-PA-22] the wrong name, a different letter case or no name deletes nothing', async () => {
    const { organizationId } = await acme();
    const before = await rowCounts(dataSource);

    for (const body of [
      { confirmName: 'olga cafe' },
      { confirmName: 'OLGA CAFE LTD' },
      { confirmName: '' },
      {},
      { confirmName: 5 },
    ]) {
      const res = await remove(organizationId, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }

    expect(await rowCounts(dataSource)).toEqual(before);
  });

  it('[UC-PA-22] spaces around the right name are fine', async () => {
    const { organizationId } = await acme();

    await remove(organizationId, { confirmName: '  olga Cafe Ltd ' }).expect(
      204,
    );
  });

  it('[UC-PA-23] a failure half way undoes the whole delete: both websites and the organization are still there', async () => {
    const { organizationId } = await acme();
    const before = await rowCounts(dataSource);
    await dataSource.query(`
      CREATE FUNCTION fail_second_site() RETURNS trigger AS $$
      BEGIN
        IF OLD.name = 'Olga Second' THEN RAISE EXCEPTION 'forced failure'; END IF;
        RETURN OLD;
      END $$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_second_site BEFORE DELETE ON sites FOR EACH ROW EXECUTE FUNCTION fail_second_site();
    `);
    try {
      const res = await remove(organizationId, {
        confirmName: 'olga Cafe Ltd',
      });

      expect(res.status).toBe(500);
    } finally {
      await dataSource.query(
        `DROP TRIGGER fail_second_site ON sites; DROP FUNCTION fail_second_site();`,
      );
    }

    expect(await rowCounts(dataSource)).toEqual(before);
    expect(
      (await api().get('/public/site').query({ host: 'olga.test', path: '/' }))
        .status,
    ).toBe(200);
  });
});

describe('ids that are not there', () => {
  it('[UC-PA-21] suspend, reactivate, change owner and delete all answer 404 for an unknown id and for one that is not an id', async () => {
    const before = await rowCounts(dataSource);
    for (const id of [crypto.randomUUID(), 'not-a-uuid', '123']) {
      const attempts = [
        api().post(`/platform/organizations/${id}/suspend`).set(ops.headers),
        api().post(`/platform/organizations/${id}/reactivate`).set(ops.headers),
        changeOwner(id, { ownerEmail: 'pat@x.test', ownerName: 'Pat' }),
        remove(id, { confirmName: 'x' }),
      ];
      for (const attempt of attempts) {
        const res = await attempt;
        expect(res.status, `${res.request.method} ${res.request.url}`).toBe(
          404,
        );
      }
    }
    expect(await rowCounts(dataSource)).toEqual(before);
  });
});
