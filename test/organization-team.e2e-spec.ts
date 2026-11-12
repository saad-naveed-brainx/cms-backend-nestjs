import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { ProvisioningService } from '../src/provisioning/provisioning.service.js';
import { Organization } from '../src/database/entities/index.js';
import { createTestApp } from './support/app.js';
import { resetDatabase } from './support/database.js';
import { invite, roleIdOf } from './support/invitations.js';
import { TEST_PASSWORD, seedMembership, seedUser } from './support/seed.js';
import { rowCounts } from './support/tenant.js';
import { signTestToken } from './support/tokens.js';

/**
 * Organizations, T3 (`docs/features/organizations/`, D-054): the owner reads the company team, which
 * is not stored but read from each website's own people. Real Postgres, real provisioning, real
 * routes and sign-ins; nothing is mocked.
 */

// Provisioning and signing in hash with production-cost scrypt (about 0.2 s each).
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

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

const signIn = async (email: string, password: string): Promise<string> =>
  (await api().post('/auth/login').send({ email, password }).expect(200)).body
    .accessToken;

/** An account that belongs nowhere yet, signed in with the real login. */
async function person(email: string, name: string): Promise<Person> {
  const user = await seedUser(dataSource, {
    email,
    name,
    password: TEST_PASSWORD,
  });
  return {
    userId: user.id,
    headers: {
      Authorization: `Bearer ${await signIn(email, TEST_PASSWORD)}`,
    },
  };
}

const roles = ['Administrator', 'Editor', 'Author', 'Contributor', 'Viewer'];

/**
 * Kettle & Crumb Ltd, owned by Ada, with two websites, Café and Shop; Maya is an Editor on Café, Tom
 * a Viewer on both; a waiting invitation for Nina as Author on Shop. And Empty Ltd, also Ada's, with
 * no website. Made by the real provisioning service and routes.
 */
async function kettleAndCrumb() {
  const tenant = await app.get(ProvisioningService).provisionTenant({
    organizationName: 'Kettle & Crumb Ltd',
    siteName: 'Café',
    hostnames: ['cafe.kettle.test'],
    admin: {
      email: 'ada@kettle.test',
      name: 'Ada Kettle',
      password: 'ada-kettle-password',
    },
  });
  const ada: Person = {
    userId: tenant.admin.id,
    headers: {
      Authorization: `Bearer ${await signIn('ada@kettle.test', 'ada-kettle-password')}`,
    },
  };
  const organizationId = tenant.organization.id;
  const cafeId = tenant.site.id;
  const shop = await api()
    .post('/sites')
    .set(ada.headers)
    .send({
      name: 'Shop',
      hostnames: ['shop.kettle.test'],
      organizationId,
    })
    .expect(201);
  const shopId: string = shop.body.site.id;
  // An organization of Ada's with no website, as the platform makes one (D-062).
  const empty = await dataSource
    .getRepository(Organization)
    .save({ name: 'Empty Ltd', ownerId: ada.userId })
    .then(({ id, name }) => ({ id, name }));

  const maya = await person('maya@kettle.test', 'Maya Thornton');
  const tom = await person('tom@kettle.test', 'Tom Ashworth');
  await seedMembership(dataSource, {
    siteId: cafeId,
    userId: maya.userId,
    roleId: await roleIdOf(app, cafeId, 'Editor'),
  });
  for (const siteId of [cafeId, shopId]) {
    await seedMembership(dataSource, {
      siteId,
      userId: tom.userId,
      roleId: await roleIdOf(app, siteId, 'Viewer'),
    });
  }
  const nina = await invite(
    app,
    { headers: { ...ada.headers, 'X-Site-Id': shopId } },
    'nina@kettle.test',
    'Author',
  );
  return { ada, maya, tom, organizationId, cafeId, shopId, empty, nina };
}

const team = (who: Person, organizationId: string) =>
  api().get(`/organizations/${organizationId}/team`).set(who.headers);

describe('the company team', () => {
  it('[UC-OR-05] the owner reads the people with their access on each website, and the waiting invitations', async () => {
    const world = await kettleAndCrumb();
    const { ada, maya, tom, cafeId, shopId, organizationId } = world;
    const roleOn = async (siteId: string, name: string) => ({
      id: await roleIdOf(app, siteId, name as 'Editor'),
      name,
    });

    const answer = await team(ada, organizationId).expect(200);
    expect(answer.body).toEqual({
      organization: { id: organizationId, name: 'Kettle & Crumb Ltd' },
      // By name; each website's own five roles, in the order the Users screen offers them.
      websites: [
        {
          id: cafeId,
          name: 'Café',
          roles: await Promise.all(roles.map((name) => roleOn(cafeId, name))),
        },
        {
          id: shopId,
          name: 'Shop',
          roles: await Promise.all(roles.map((name) => roleOn(shopId, name))),
        },
      ],
      // Three people, each once, by name; the owner flagged; Tom twice.
      people: [
        {
          userId: ada.userId,
          name: 'Ada Kettle',
          email: 'ada@kettle.test',
          isOwner: true,
          access: [
            { siteId: cafeId, role: await roleOn(cafeId, 'Administrator') },
            { siteId: shopId, role: await roleOn(shopId, 'Administrator') },
          ],
        },
        {
          userId: maya.userId,
          name: 'Maya Thornton',
          email: 'maya@kettle.test',
          isOwner: false,
          access: [{ siteId: cafeId, role: await roleOn(cafeId, 'Editor') }],
        },
        {
          userId: tom.userId,
          name: 'Tom Ashworth',
          email: 'tom@kettle.test',
          isOwner: false,
          access: [
            { siteId: cafeId, role: await roleOn(cafeId, 'Viewer') },
            { siteId: shopId, role: await roleOn(shopId, 'Viewer') },
          ],
        },
      ],
      invitations: [
        {
          id: world.nina.id,
          email: 'nina@kettle.test',
          siteId: shopId,
          role: await roleOn(shopId, 'Author'),
          expiresAt: expect.any(String),
          expired: false,
        },
      ],
    });

    // Nothing in it is a secret: no password hash, no invitation link or its fingerprint.
    const text = JSON.stringify(answer.body);
    expect(text).not.toContain('password');
    expect(text).not.toContain(world.nina.token);
    expect(text).not.toMatch(/token/i);

    // The organization with no website answers empty lists.
    const empty = await team(ada, world.empty.id).expect(200);
    expect(empty.body).toEqual({
      organization: { id: world.empty.id, name: 'Empty Ltd' },
      websites: [],
      people: [],
      invitations: [],
    });
  });

  it('[UC-OR-05] reading the team changes nothing, and a person on no website is not on it', async () => {
    const { ada, organizationId } = await kettleAndCrumb();
    // Someone with an account and no website anywhere is not part of any team.
    await person('lone@kettle.test', 'Lone Wolf');
    const before = await rowCounts(dataSource);

    const first = await team(ada, organizationId).expect(200);
    const again = await team(ada, organizationId).expect(200);
    expect(again.body).toEqual(first.body);
    expect(await rowCounts(dataSource)).toEqual(before);
    expect(JSON.stringify(first.body)).not.toContain('lone@kettle.test');

    // An expired invitation is still listed, as expired, as the Users screen lists it.
    await dataSource.query(
      `UPDATE invitations SET expires_at = now() - interval '1 day'`,
    );
    const later = await team(ada, organizationId).expect(200);
    expect(later.body.invitations).toHaveLength(1);
    expect(later.body.invitations[0].expired).toBe(true);
  });

  it('[UC-OR-06] no token or an expired one is 401 and nothing is created; the owner gets 200, a member who is not the owner 403, everyone else the same 404', async () => {
    const world = await kettleAndCrumb();
    const { ada, tom, organizationId } = world;

    // Another organization's owner, and a person with no part in it.
    const other = await app.get(ProvisioningService).provisionTenant({
      organizationName: 'Other Co',
      siteName: 'Other Site',
      hostnames: ['other.test'],
      admin: {
        email: 'olga@other.test',
        name: 'Olga Other',
        password: 'olga-other-password',
      },
    });
    const olga: Person = {
      userId: other.admin.id,
      headers: {
        Authorization: `Bearer ${await signIn('olga@other.test', 'olga-other-password')}`,
      },
    };
    const stranger = await person('stranger@nowhere.test', 'Sam Stranger');

    // No token, and a token that ran out an hour ago: 401, and nothing is made.
    const now = Math.floor(Date.now() / 1000);
    const expired = {
      Authorization: `Bearer ${await signTestToken({ sub: ada.userId, iat: now - 7200, exp: now - 3600 })}`,
    };
    const before = await rowCounts(dataSource);
    for (const headers of [{}, expired]) {
      await api()
        .get(`/organizations/${organizationId}/team`)
        .set(headers)
        .expect(401);
      await api()
        .post('/platform/organizations')
        .set(headers)
        .send({ name: 'Nobody Ltd', ownerEmail: 'nobody@x.test' })
        .expect(401);
    }
    expect(await rowCounts(dataSource)).toEqual(before);

    // The owner: 200. A Viewer on one of its websites: 403.
    await team(ada, organizationId).expect(200);
    await team(tom, organizationId).expect(403);

    // Everyone else: the same 404 with the same message, however it came about.
    const missing = '3f6b9f0a-5c1e-4a52-8d0f-0f6b2f2f6a11';
    const answers = [
      await team(olga, organizationId),
      await team(stranger, organizationId),
      await team(ada, missing),
      await team(ada, 'not-a-uuid'),
      await team(ada, `${organizationId}x`),
      // An organization that exists but is another owner's.
      await team(ada, other.organization.id),
    ];
    for (const answer of answers) {
      expect(answer.status).toBe(404);
      expect(answer.body.message).toBe(answers[0].body.message);
    }
    // The message says nothing about which organizations exist.
    expect(JSON.stringify(answers[0].body)).not.toContain(organizationId);
    expect(JSON.stringify(answers[0].body)).not.toContain('Kettle');
  });

  it('[UC-OR-06] an upper-case id is the same organization', async () => {
    const { ada, organizationId } = await kettleAndCrumb();
    const answer = await team(ada, organizationId.toUpperCase()).expect(200);
    expect(answer.body.organization.id).toBe(organizationId);
  });
});
