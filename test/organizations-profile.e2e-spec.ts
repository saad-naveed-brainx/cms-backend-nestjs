import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { createTestApp } from './support/app.js';
import { resetDatabase } from './support/database.js';
import {
  INVITE_GONE,
  invite,
  newClient,
  roleIdOf,
} from './support/invitations.js';
import { seedMembership } from './support/seed.js';
import { Organization } from '../src/database/entities/index.js';

/**
 * Organizations, T1 (`docs/features/organizations/`): the sign-in and `/auth/me` answers list the
 * organizations a person owns or has a website in, each website says which organization it belongs
 * to, and an invitation's lookup names its site and organization by id. Real Postgres, real
 * provisioning, real sign-ins; nothing is mocked.
 */

// Provisioning hashes with production-cost scrypt (about 0.2 s each).
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

const orchard = () =>
  newClient(app, {
    prefix: 'orchard',
    adminName: 'Olivia Orchard',
    siteName: 'Orchard Bakery',
  });
const maple = () =>
  newClient(app, {
    prefix: 'maple',
    adminName: 'Max Maple',
    siteName: 'Maple Books',
  });

const signIn = (prefix: string) =>
  api()
    .post('/auth/login')
    .send({
      email: `${prefix}-owner@${prefix}.test`,
      password: `${prefix}-owner-password`,
    });

const organizationOf = async (siteId: string) => {
  const [row] = await dataSource.query<{ id: string; name: string }[]>(
    'SELECT o.id, o.name FROM organizations o JOIN sites s ON s.organization_id = o.id WHERE s.id = $1',
    [siteId],
  );
  return row;
};

describe('the profile lists the organizations', () => {
  it("[UC-OR-01] sign-in and /auth/me list the person's organizations and each website's organization", async () => {
    const olivia = await orchard();
    const max = await maple();
    // Olivia also owns an organization with no website yet, and is an Editor on Max's website.
    await dataSource.getRepository(Organization).save({
      name: 'Spare Ltd',
      ownerId: olivia.userId,
    });
    await seedMembership(dataSource, {
      siteId: max.siteId,
      userId: olivia.userId,
      roleId: await roleIdOf(app, max.siteId, 'Editor'),
    });
    const orchardOrg = await organizationOf(olivia.siteId);
    const mapleOrg = await organizationOf(max.siteId);

    const login = await signIn('orchard').expect(200);
    const me = await api().get('/auth/me').set(olivia.headers).expect(200);

    for (const answer of [login.body, me.body]) {
      // By name: Maple Books Ltd (not hers), Orchard Bakery Ltd and Spare Ltd (hers).
      expect(answer.organizations).toEqual([
        {
          id: mapleOrg.id,
          name: 'Maple Books Ltd',
          ownsOrganization: false,
          suspended: false,
        },
        {
          id: orchardOrg.id,
          name: 'Orchard Bakery Ltd',
          ownsOrganization: true,
          suspended: false,
        },
        {
          id: expect.any(String),
          name: 'Spare Ltd',
          ownsOrganization: true,
          suspended: false,
        },
      ]);
      const organizationIdOf = (siteId: string) =>
        answer.memberships.find((m: any) => m.site.id === siteId).site
          .organizationId;
      expect(organizationIdOf(olivia.siteId)).toBe(orchardOrg.id);
      expect(organizationIdOf(max.siteId)).toBe(mapleOrg.id);
    }

    // Someone with one website in one organization gets one entry.
    const maxMe = await api().get('/auth/me').set(max.headers).expect(200);
    expect(maxMe.body.organizations).toEqual([
      {
        id: mapleOrg.id,
        name: 'Maple Books Ltd',
        ownsOrganization: true,
        suspended: false,
      },
    ]);
  });
});

describe('an invitation names its site and organization', () => {
  it('[UC-OR-02] the lookup names the site and organization by id, and accepting answers with the organizations', async () => {
    const olivia = await orchard();
    const org = await organizationOf(olivia.siteId);
    const { token } = await invite(app, olivia, 'nina@orchard.test', 'Author');

    const lookup = await api()
      .post('/invitations/lookup')
      .send({ token })
      .expect(200);
    expect(lookup.body).toEqual({
      site: { id: olivia.siteId, name: 'Orchard Bakery' },
      organization: { id: org.id, name: org.name },
      role: { name: 'Author' },
      email: 'nina@orchard.test',
      hasAccount: false,
      expiresAt: expect.any(String),
    });

    const accepted = await api()
      .post('/invitations/accept')
      .send({ token, name: 'Nina Novak', password: 'a long enough password' })
      .expect(200);
    expect(accepted.body.organizations).toEqual([
      { id: org.id, name: org.name, ownsOrganization: false, suspended: false },
    ]);
    expect(accepted.body.memberships).toHaveLength(1);
    expect(accepted.body.memberships[0].site.organizationId).toBe(org.id);

    // A used link is still the one 404 every dead link gets.
    const again = await api().post('/invitations/lookup').send({ token });
    expect(again.status).toBe(404);
    expect(again.body.message).toBe(INVITE_GONE);
  });
});
