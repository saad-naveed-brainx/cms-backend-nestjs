import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { createTestApp } from './support/app.js';
import { resetDatabase } from './support/database.js';
import { roleIdOf } from './support/invitations.js';
import { TEST_PASSWORD, seedMembership, seedUser } from './support/seed.js';
import { rowCounts } from './support/tenant.js';

/**
 * Organizations, T2 (`docs/features/organizations/`): any signed-in person creates an organization by
 * name and owns it (D-056). Real Postgres, real sign-ins, real routes; nothing is mocked.
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

const createOrganization = (who: Person, body: unknown) =>
  api()
    .post('/organizations')
    .set(who.headers)
    .send(body as object);
const createSite = (who: Person, body: unknown) =>
  api()
    .post('/sites')
    .set(who.headers)
    .send(body as object);
const owned = async (who: Person) =>
  (await api().get('/organizations').set(who.headers).expect(200)).body
    .items as { id: string; name: string }[];
const organizationRows = () =>
  dataSource.query<{ id: string; name: string; owner_id: string }[]>(
    'SELECT id, name, owner_id FROM organizations ORDER BY name, id',
  );

describe('creating an organization', () => {
  it('[UC-OR-03] a signed-in person who owns nothing creates an organization, and it is theirs', async () => {
    const hanna = await person('hanna@harbour.test', 'Hanna Harbour');
    expect(await owned(hanna)).toEqual([]);

    const created = await createOrganization(hanna, {
      name: 'Harbour Studio',
    }).expect(201);
    expect(created.body).toEqual({
      id: expect.any(String),
      name: 'Harbour Studio',
    });

    // The row is hers.
    expect(await organizationRows()).toEqual([
      { id: created.body.id, name: 'Harbour Studio', owner_id: hanna.userId },
    ]);

    // Her profile lists it, owned, with no website yet; the list of what she owns holds it.
    const me = await api().get('/auth/me').set(hanna.headers).expect(200);
    expect(me.body.organizations).toEqual([
      { id: created.body.id, name: 'Harbour Studio', ownsOrganization: true },
    ]);
    expect(me.body.memberships).toEqual([]);
    expect(await owned(hanna)).toEqual([created.body]);

    // A website in it: no need to name the organization (it is the only one), and she is its Administrator.
    const site = await createSite(hanna, {
      name: 'Harbour Studio Site',
      hostnames: ['harbour-studio.test'],
    }).expect(201);
    expect(site.body.organization).toEqual(created.body);
    expect(site.body.membership.role.name).toBe('Administrator');
    const after = await api().get('/auth/me').set(hanna.headers).expect(200);
    expect(after.body.memberships).toHaveLength(1);
    expect(after.body.memberships[0]).toMatchObject({
      role: { name: 'Administrator' },
      ownsOrganization: true,
      site: { id: site.body.site.id, organizationId: created.body.id },
    });

    // Without a sign-in nothing is made.
    const before = await rowCounts(dataSource);
    await api().post('/organizations').send({ name: 'Nobody Ltd' }).expect(401);
    expect(await rowCounts(dataSource)).toEqual(before);
  });

  it('[UC-OR-04] the name is trimmed, bounded, kept as text, and may repeat', async () => {
    const pat = await person('pat@harbour.test', 'Pat Harbour');

    const trimmed = await createOrganization(pat, {
      name: '  Harbour  ',
    }).expect(201);
    expect(trimmed.body.name).toBe('Harbour');
    const longest = await createOrganization(pat, {
      name: 'x'.repeat(100),
    }).expect(201);
    expect(longest.body.name).toBe('x'.repeat(100));

    // Kept exactly as typed: nothing is stripped or escaped on the way in.
    const markup = '<b>Bold</b> 🚀';
    const kept = await createOrganization(pat, { name: markup }).expect(201);
    expect(kept.body.name).toBe(markup);

    // Refused with the problem on `name`, and nothing is created.
    const before = await rowCounts(dataSource);
    const refused: [string, unknown][] = [
      ['101 characters', { name: 'x'.repeat(101) }],
      ['empty', { name: '' }],
      ['spaces only', { name: '   ' }],
      ['missing', {}],
      ['not text', { name: 42 }],
      [
        'a NUL character (Postgres cannot store one)',
        { name: 'Har\u0000bour' },
      ],
    ];
    for (const [label, body] of refused) {
      const answer = await createOrganization(pat, body).expect(400);
      expect(answer.body.message, label).toBe('Invalid request');
      expect(answer.body.errors.join(), label).toContain('name');
    }
    expect(await rowCounts(dataSource)).toEqual(before);

    // The same name a second time is a separate organization with its own id.
    const again = await createOrganization(pat, { name: 'Harbour' }).expect(
      201,
    );
    expect(again.body.id).not.toBe(trimmed.body.id);
    const rows = await organizationRows();
    expect(rows.map(({ name }) => name).sort()).toEqual(
      ['Harbour', 'Harbour', markup, 'x'.repeat(100)].sort(),
    );
    expect(rows.every(({ owner_id }) => owner_id === pat.userId)).toBe(true);
    expect((await owned(pat)).map(({ id }) => id).sort()).toEqual(
      rows.map(({ id }) => id).sort(),
    );
  });

  it('[UC-OR-35] a body that says more than the name is refused: the caller always owns it', async () => {
    const pat = await person('pat@harbour.test', 'Pat Harbour');
    const other = await person('other@elsewhere.test', 'Olle Other');

    const before = await rowCounts(dataSource);
    for (const extra of [
      { ownerId: other.userId },
      { id: '5b6c3f6e-3b71-4a59-9f6a-2b6a4a1d9c11' },
      { siteId: '5b6c3f6e-3b71-4a59-9f6a-2b6a4a1d9c11' },
    ]) {
      const answer = await createOrganization(pat, {
        name: 'Sneaky',
        ...extra,
      }).expect(400);
      expect(answer.body.message).toBe('Invalid request');
      expect(answer.body.errors.length).toBeGreaterThan(0);
    }
    expect(await rowCounts(dataSource)).toEqual(before);
    expect(await owned(other)).toEqual([]);
  });
});

describe('the routes beside it', () => {
  it('[UC-OR-12] listing what you own and adding a website behave as before', async () => {
    const ada = await person('ada@works.test', 'Ada Works');
    const bo = await person('bo@works.test', 'Bo Works');
    const cy = await person('cy@works.test', 'Cy Works');

    // Ada owns two, made in the opposite order of their names; Bo owns one; Cy owns none.
    const beta = (
      await createOrganization(ada, { name: 'Beta Works' }).expect(201)
    ).body;
    const alpha = (
      await createOrganization(ada, { name: 'Alpha Works' }).expect(201)
    ).body;
    const boOrg = (
      await createOrganization(bo, { name: 'Bo Works' }).expect(201)
    ).body;

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
      { id: alpha.id, name: 'Alpha Works', ownsOrganization: false },
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
