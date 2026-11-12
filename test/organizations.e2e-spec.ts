import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { Organization } from '../src/database/entities/index.js';
import { createTestApp } from './support/app.js';
import { resetDatabase } from './support/database.js';
import { roleIdOf } from './support/invitations.js';
import { TEST_PASSWORD, seedMembership, seedUser } from './support/seed.js';
import { rowCounts } from './support/tenant.js';

/**
 * Organizations (`docs/features/organizations/`): the organizations a person owns and adding a website
 * to one. Since the super admin (D-062, supersedes D-056) nobody makes an organization by a route of their
 * own: the tests make them as the platform does, owned by a person. Real Postgres, real sign-ins, real
 * routes; nothing is mocked.
 */

// Signing in hashes with production-cost scrypt (about 0.2 s each).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

let app: INestApplication;
let dataSource: DataSource;
const api = () => request(app.getHttpServer());

beforeAll(async () => {
  ({ app, dataSource } = await createTestApp());
  await app.listen(0, '127.0.0.1');
});

beforeEach(async () => {
  await resetDatabase(dataSource);
});

afterAll(async () => {
  await app.close();
});

type Person = { userId: string; headers: { Authorization: string } };

/** An account that owns nothing and belongs nowhere, signed in with the real login. */
async function person(email: string, name: string): Promise<Person> {
  const user = await seedUser(dataSource, {
    email,
    name,
    password: TEST_PASSWORD,
  });
  const login = await api()
    .post('/auth/login')
    .send({ email, password: TEST_PASSWORD })
    .expect(200);
  return {
    userId: user.id,
    headers: { Authorization: `Bearer ${login.body.accessToken}` },
  };
}

/** An organization owned by this person, made as the platform makes one (D-062). */
const makeOrganization = async (
  who: Person,
  name: string,
): Promise<{ id: string; name: string }> => {
  const row = await dataSource
    .getRepository(Organization)
    .save({ name, ownerId: who.userId });
  return { id: row.id, name: row.name };
};
const createSite = (who: Person, body: unknown) =>
  api()
    .post('/sites')
    .set(who.headers)
    .send(body as object);
const owned = async (who: Person) =>
  (await api().get('/organizations').set(who.headers).expect(200)).body
    .items as { id: string; name: string }[];

describe("an organization of one's own", () => {
  it('[UC-OR-03] an owner sees it listed with no website yet, and adds the first website to it as its Administrator', async () => {
    const hanna = await person('hanna@harbour.test', 'Hanna Harbour');
    expect(await owned(hanna)).toEqual([]);

    const created = await makeOrganization(hanna, 'Harbour Studio');

    // Her profile lists it, owned, with no website yet; the list of what she owns holds it.
    const me = await api().get('/auth/me').set(hanna.headers).expect(200);
    expect(me.body.organizations).toEqual([
      {
        id: created.id,
        name: 'Harbour Studio',
        ownsOrganization: true,
        suspended: false,
      },
    ]);
    expect(me.body.memberships).toEqual([]);
    expect(await owned(hanna)).toEqual([created]);

    // A website in it: no need to name the organization (it is the only one), and she is its Administrator.
    const site = await createSite(hanna, {
      name: 'Harbour Studio Site',
      hostnames: ['harbour-studio.test'],
    }).expect(201);
    expect(site.body.organization).toEqual(created);
    expect(site.body.membership.role.name).toBe('Administrator');
    const after = await api().get('/auth/me').set(hanna.headers).expect(200);
    expect(after.body.memberships).toHaveLength(1);
    expect(after.body.memberships[0]).toMatchObject({
      role: { name: 'Administrator' },
      ownsOrganization: true,
      site: { id: site.body.site.id, organizationId: created.id },
    });
  });
});

describe('the routes beside it', () => {
  it('[UC-OR-12] listing what you own and adding a website behave as before', async () => {
    const ada = await person('ada@works.test', 'Ada Works');
    const bo = await person('bo@works.test', 'Bo Works');
    const cy = await person('cy@works.test', 'Cy Works');

    // Ada owns two, made in the opposite order of their names; Bo owns one; Cy owns none.
    const beta = await makeOrganization(ada, 'Beta Works');
    const alpha = await makeOrganization(ada, 'Alpha Works');
    const boOrg = await makeOrganization(bo, 'Bo Works');

    // Cy is on a website of Alpha, which is Ada's.
    const alphaSite = (
      await createSite(ada, {
        name: 'Alpha Site',
        hostnames: ['alpha.works.test'],
        organizationId: alpha.id,
      }).expect(201)
    ).body.site;
    await seedMembership(dataSource, {
      siteId: alphaSite.id,
      userId: cy.userId,
      roleId: await roleIdOf(app, alphaSite.id, 'Editor'),
    });

    // The list holds only what the person owns, in name order, never one they only belong to.
    expect(await owned(ada)).toEqual([alpha, beta]);
    expect(await owned(bo)).toEqual([boOrg]);
    expect(await owned(cy)).toEqual([]);
    const cyProfile = await api().get('/auth/me').set(cy.headers).expect(200);
    expect(cyProfile.body.organizations).toEqual([
      {
        id: alpha.id,
        name: 'Alpha Works',
        ownsOrganization: false,
        suspended: false,
      },
    ]);

    // A website needs the organization named only when two are owned; naming one that is not yours,
    // and owning none, are 403. Every refusal creates nothing.
    const before = await rowCounts(dataSource);
    const unnamed = await createSite(ada, {
      name: 'Nowhere',
      hostnames: ['nowhere.works.test'],
    }).expect(400);
    expect(unnamed.body.errors.join()).toContain('organizationId');
    await createSite(ada, {
      name: 'Hijack',
      hostnames: ['hijack.works.test'],
      organizationId: boOrg.id,
    }).expect(403);
    await createSite(cy, {
      name: 'Not Mine',
      hostnames: ['not-mine.works.test'],
      organizationId: alpha.id,
    }).expect(403);
    await createSite(cy, {
      name: 'Not Mine',
      hostnames: ['not-mine.works.test'],
    }).expect(403);
    expect(await rowCounts(dataSource)).toEqual(before);

    // With one owned it is used without naming it; with two, naming one works.
    const boSite = await createSite(bo, {
      name: 'Bo Site',
      hostnames: ['bo.works.test'],
    }).expect(201);
    expect(boSite.body.organization).toEqual(boOrg);
    const betaSite = await createSite(ada, {
      name: 'Beta Site',
      hostnames: ['beta.works.test'],
      organizationId: beta.id,
    }).expect(201);
    expect(betaSite.body.organization).toEqual(beta);
  });
});
