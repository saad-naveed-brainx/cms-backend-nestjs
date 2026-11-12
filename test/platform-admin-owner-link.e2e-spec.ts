import { createHash } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import {
  Organization,
  OrganizationInvitation,
  User,
} from '../src/database/entities/index.js';
import { PlatformAdminService } from '../src/platform-admin/platform-admin.service.js';
import { createTestApp } from './support/app.js';
import { resetDatabase } from './support/database.js';
import { invite, newClient, roleIdOf } from './support/invitations.js';
import { newSuperAdmin, type SuperAdmin } from './support/platform-admin.js';
import { rowCounts } from './support/tenant.js';

/**
 * Platform admin T3: the owner link. A super admin makes an organization for a new person; the person
 * opens the link, accepts it and becomes the owner. Real Postgres, real sign-ins, nothing mocked.
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

const NIA = { email: 'nia@x.test', name: 'Nia' };
const PASSWORD = 'nia-owner-password';

/** An organization waiting for Nia, and the secret of her link. */
async function awaitingOrganization(name = 'Beta') {
  const res = await api()
    .post('/platform/organizations')
    .set(ops.headers)
    .send({ name, ownerEmail: NIA.email, ownerName: NIA.name })
    .expect(201);
  return {
    id: res.body.id as string,
    token: res.body.ownerInvitation.token as string,
  };
}

const lookup = (token: string) =>
  api().post('/invitations/lookup').send({ token });
const accept = (token: string, body: Record<string, unknown> = {}) =>
  api()
    .post('/invitations/accept')
    .send({ token, password: PASSWORD, name: NIA.name, ...body });
const sha256 = (text: string) =>
  createHash('sha256').update(text).digest('hex');

describe('looking an owner link up', () => {
  it('[UC-PA-05] says which organization it is for, and that it is an owner link', async () => {
    const { id, token } = await awaitingOrganization();

    const res = await lookup(token);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      kind: 'owner',
      organization: { id, name: 'Beta' },
      email: NIA.email,
      name: NIA.name,
      hasAccount: false,
      expiresAt: expect.any(String),
    });
    expect(JSON.stringify(res.body)).not.toContain(token);
  });

  it('[UC-PA-36] a website invitation still looks up as before, with no owner marker', async () => {
    const olga = await newClient(app, {
      prefix: 'olga',
      adminName: 'Olga',
      siteName: 'Olga Cafe',
    });
    await awaitingOrganization();
    const made = await invite(app, olga, 'pat@x.test', 'Editor');

    const res = await lookup(made.token);

    expect(res.status).toBe(200);
    expect(res.body.kind).toBeUndefined();
    expect(res.body).toMatchObject({
      site: { id: olga.siteId, name: 'Olga Cafe' },
      role: { name: 'Editor' },
      email: 'pat@x.test',
    });
  });
});

describe('accepting an owner link', () => {
  it('[UC-PA-05] makes the account and the owner, signs them in, and uses the link up', async () => {
    const { id, token } = await awaitingOrganization();

    const res = await accept(token);

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({
      email: NIA.email,
      name: NIA.name,
      isPlatformAdmin: false,
    });
    expect(res.body.organizations).toEqual([
      { id, name: 'Beta', ownsOrganization: true, suspended: false },
    ]);
    expect(res.body.memberships).toEqual([]);
    const user = await dataSource
      .getRepository(User)
      .findOneByOrFail({ email: NIA.email });
    const org = await dataSource
      .getRepository(Organization)
      .findOneByOrFail({ id });
    expect(org.ownerId).toBe(user.id);
    expect(await dataSource.getRepository(OrganizationInvitation).count()).toBe(
      0,
    );
    await api()
      .post('/auth/login')
      .send({ email: NIA.email, password: PASSWORD })
      .expect(200);
    const listed = await api()
      .get('/platform/organizations')
      .set(ops.headers)
      .expect(200);
    expect(listed.body.items[0]).toMatchObject({
      status: 'active',
      pendingOwnerEmail: null,
      owner: { email: NIA.email },
    });
  });

  it('[UC-PA-13] works once: the second use is a 404 and changes nothing', async () => {
    const { token } = await awaitingOrganization();
    await accept(token).expect(200);
    const before = await rowCounts(dataSource);

    const again = await accept(token);
    const looked = await lookup(token);

    expect(again.status).toBe(404);
    expect(again.body.message).toBe(
      'This invite is no longer valid. Ask for a new one.',
    );
    expect(looked.status).toBe(404);
    expect(await rowCounts(dataSource)).toEqual(before);
  });

  it('[UC-PA-13] two accepts at once make one owner and one account', async () => {
    const { id, token } = await awaitingOrganization();

    const results = await Promise.all([accept(token), accept(token)]);

    expect(results.map((r) => r.status).sort()).toEqual([200, 404]);
    expect(
      await dataSource.getRepository(User).countBy({ email: NIA.email }),
    ).toBe(1);
    const org = await dataSource
      .getRepository(Organization)
      .findOneByOrFail({ id });
    expect(org.ownerId).not.toBeNull();
  });

  it('[UC-PA-12] an expired link is the same 404, and nothing is created', async () => {
    const { token } = await awaitingOrganization();
    await dataSource.query(
      `UPDATE organization_invitations SET expires_at = now() - interval '1 minute'`,
    );
    const before = await rowCounts(dataSource);

    const looked = await lookup(token);
    const accepted = await accept(token);

    expect(looked.status).toBe(404);
    expect(accepted.status).toBe(404);
    expect(await rowCounts(dataSource)).toEqual(before);
    expect(
      await dataSource.getRepository(User).countBy({ email: NIA.email }),
    ).toBe(0);
  });

  it('[UC-PA-12] a link that never existed, or is malformed, is the same 404', async () => {
    for (const token of ['nonsense', '', 'a'.repeat(43)]) {
      expect((await lookup(token)).status, token).toBe(404);
      expect((await accept(token)).status, token).toBe(404);
    }
  });

  it('[UC-PA-12] a new account needs a name and a password of 12 or more characters, else a 400 and the link stays', async () => {
    const { token } = await awaitingOrganization();

    const shortPassword = await accept(token, { password: 'short' });
    const noName = await api()
      .post('/invitations/accept')
      .send({ token, password: PASSWORD });

    expect(shortPassword.status).toBe(400);
    expect(noName.status).toBe(400);
    await accept(token).expect(200);
  });

  it('[UC-PA-14] gives the new owner Administrator on every website the organization already has', async () => {
    const maker = await newClient(app, {
      prefix: 'maker',
      adminName: 'Maker',
      siteName: 'Maker Cafe',
    });
    const organizationId = (
      await dataSource.query(
        `SELECT organization_id FROM sites WHERE id = $1`,
        [maker.siteId],
      )
    )[0].organization_id as string;
    await dataSource.query(
      `UPDATE organizations SET owner_id = NULL WHERE id = $1`,
      [organizationId],
    );
    const issued = await app
      .get(PlatformAdminService)
      .issueOwnerInvitation(
        (
          await dataSource
            .getRepository(User)
            .findOneByOrFail({ email: ops.email })
        ).id,
        organizationId,
        { ownerEmail: NIA.email, ownerName: NIA.name },
      );

    const res = await accept(issued!.token);

    expect(res.status).toBe(200);
    expect(res.body.memberships).toHaveLength(1);
    expect(res.body.memberships[0]).toMatchObject({
      site: { id: maker.siteId },
      role: { name: 'Administrator' },
      ownsOrganization: true,
    });
  });

  it('[UC-PA-14] an existing account signs in with its password, and is raised to Administrator where it was lower', async () => {
    const maker = await newClient(app, {
      prefix: 'maker',
      adminName: 'Maker',
      siteName: 'Maker Cafe',
    });
    const pat = await newClient(app, {
      prefix: 'pat',
      adminName: 'Pat',
      siteName: 'Pat Cafe',
    });
    await dataSource.query(
      `INSERT INTO site_members (site_id, user_id, role_id) VALUES ($1, $2, $3)`,
      [maker.siteId, pat.userId, await roleIdOf(app, maker.siteId, 'Editor')],
    );
    const organizationId = (
      await dataSource.query(
        `SELECT organization_id FROM sites WHERE id = $1`,
        [maker.siteId],
      )
    )[0].organization_id as string;
    await dataSource.query(
      `UPDATE organizations SET owner_id = NULL WHERE id = $1`,
      [organizationId],
    );
    const opsId = (
      await dataSource.getRepository(User).findOneByOrFail({ email: ops.email })
    ).id;
    const issued = await app
      .get(PlatformAdminService)
      .issueOwnerInvitation(opsId, organizationId, {
        ownerEmail: 'pat-owner@pat.test',
        ownerName: 'Pat',
      });
    const looked = await lookup(issued!.token);
    expect(looked.body.hasAccount).toBe(true);

    const wrong = await api()
      .post('/invitations/accept')
      .send({ token: issued!.token, password: 'not-the-password' });
    const withName = await api().post('/invitations/accept').send({
      token: issued!.token,
      password: 'not-the-password',
      name: 'Pat',
    });
    const right = await api()
      .post('/invitations/accept')
      .send({ token: issued!.token, password: 'pat-owner-password' });

    expect(wrong.status).toBe(401);
    expect(withName.status).toBe(409);
    expect(right.status).toBe(200);
    const mine = right.body.memberships.find(
      (m: { site: { id: string } }) => m.site.id === maker.siteId,
    );
    expect(mine).toMatchObject({
      role: { name: 'Administrator' },
      ownsOrganization: true,
    });
  });
});

describe('replacing an owner link', () => {
  it('[UC-PA-11] a new link for the same email stops the old one and works itself', async () => {
    const { id, token: first } = await awaitingOrganization();
    const opsId = (
      await dataSource.getRepository(User).findOneByOrFail({ email: ops.email })
    ).id;

    const second = await app
      .get(PlatformAdminService)
      .issueOwnerInvitation(opsId, id, {
        ownerEmail: NIA.email,
        ownerName: NIA.name,
      });

    expect(second!.token).not.toBe(first);
    expect(await dataSource.getRepository(OrganizationInvitation).count()).toBe(
      1,
    );
    expect((await lookup(first)).status).toBe(404);
    expect((await lookup(second!.token)).status).toBe(200);
    const row = await dataSource
      .getRepository(OrganizationInvitation)
      .findOneByOrFail({ organizationId: id });
    expect(row.tokenHash).toBe(sha256(second!.token));
    await accept(second!.token).expect(200);
  });

  it('[UC-PA-11] gives nothing for an organization that does not exist, and a handover leaves the owner in place until the link is used', async () => {
    const olga = await newClient(app, {
      prefix: 'olga',
      adminName: 'Olga',
      siteName: 'Olga Cafe',
    });
    const owned = (
      await dataSource.query(
        `SELECT organization_id FROM sites WHERE id = $1`,
        [olga.siteId],
      )
    )[0].organization_id as string;
    const opsId = (
      await dataSource.getRepository(User).findOneByOrFail({ email: ops.email })
    ).id;
    const service = app.get(PlatformAdminService);
    const body = { ownerEmail: NIA.email, ownerName: NIA.name };

    expect(
      await service.issueOwnerInvitation(opsId, crypto.randomUUID(), body),
    ).toBeNull();
    expect(
      await service.issueOwnerInvitation(opsId, 'not-a-uuid', body),
    ).toBeNull();
    expect(await dataSource.getRepository(OrganizationInvitation).count()).toBe(
      0,
    );

    const handover = await service.issueOwnerInvitation(opsId, owned, body);

    expect(handover).not.toBeNull();
    const org = await dataSource
      .getRepository(Organization)
      .findOneByOrFail({ id: owned });
    expect(org.ownerId).toBe(olga.userId);
    expect(await dataSource.getRepository(OrganizationInvitation).count()).toBe(
      1,
    );
  });
});

describe("an organization that waits for its owner is nobody's", () => {
  it('[UC-PA-32] no one can read its team, add a website to it, or be told it exists', async () => {
    const olga = await newClient(app, {
      prefix: 'olga',
      adminName: 'Olga',
      siteName: 'Olga Cafe',
    });
    const { id } = await awaitingOrganization();
    const auth = { Authorization: olga.headers.Authorization };

    const team = await api().get(`/organizations/${id}/team`).set(auth);
    const site = await api()
      .post('/sites')
      .set(auth)
      .send({ name: 'Sneaky', hostnames: ['sneaky.test'], organizationId: id });
    const owned = await api().get('/organizations').set(auth).expect(200);

    expect(team.status).toBe(404);
    expect(site.status).toBe(403);
    expect(owned.body.items.map((o: { id: string }) => o.id)).not.toContain(id);
    expect(await dataSource.getRepository(Organization).countBy({ id })).toBe(
      1,
    );
    expect(
      await dataSource.query(`SELECT 1 FROM sites WHERE name = 'Sneaky'`),
    ).toEqual([]);
  });
});
