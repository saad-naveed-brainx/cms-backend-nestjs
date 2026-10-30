import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { createTestApp } from './support/app.js';
import { resetDatabase } from './support/database.js';
import {
  INVITE_GONE,
  SEVEN_DAYS_MS,
  expectFieldError,
  invite,
  newClient,
} from './support/invitations.js';
import { addMember } from './support/members.js';
import { TEST_PASSWORD, seedUser } from './support/seed.js';

/**
 * Users and roles, T3 (`docs/features/users-roles/`), the invited person's side: looking a link up
 * and accepting it, as a new account or with an existing one; a link working once; dead links all
 * answering the same; and the accept input rules. Both routes are public: no sign-in is sent.
 * Real Postgres, real provisioning, real sign-ins; nothing is mocked.
 */

// Provisioning and new accounts hash with production-cost scrypt (about 0.2 s each).
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

const kettle = () =>
  newClient(app, {
    prefix: 'kettle',
    adminName: 'Olivia Owner',
    siteName: 'Kettle & Crumb',
  });
const halden = () =>
  newClient(app, {
    prefix: 'halden',
    adminName: 'Hana Halden',
    siteName: 'Studio Halden',
  });

const lookup = (token: unknown) =>
  api().post('/invitations/lookup').send({ token });
const accept = (body: object) => api().post('/invitations/accept').send(body);

const NEW_PASSWORD = 'sara-new-password-123';

async function usersWithEmail(email: string) {
  return dataSource.query<
    { id: string; name: string; password_hash: string }[]
  >('SELECT id, name, password_hash FROM users WHERE email = $1', [email]);
}

async function membershipsOf(userId: string) {
  return dataSource.query<{ site_id: string; role: string }[]>(
    `SELECT m.site_id, r.name AS role FROM site_members m JOIN roles r ON r.id = m.role_id
      WHERE m.user_id = $1 ORDER BY r.name`,
    [userId],
  );
}

async function counts() {
  const [row] = await dataSource.query<
    { users: number; members: number; invitations: number }[]
  >(
    `SELECT (SELECT count(*)::int FROM users) AS users,
            (SELECT count(*)::int FROM site_members) AS members,
            (SELECT count(*)::int FROM invitations) AS invitations`,
  );
  return row;
}

/** `{ siteId: roleName }` from a sign-in answer's memberships. */
const rolesBySite = (body: {
  memberships: { site: { id: string }; role: { name: string } }[];
}) => Object.fromEntries(body.memberships.map((m) => [m.site.id, m.role.name]));

describe('a new person', () => {
  it('[UC-UR-06] Sara is invited as Contributor, looks the link up, creates her account by accepting, is signed in, listed, and can sign in again', async () => {
    const olivia = await kettle();
    const before = Date.now();
    const sara = await invite(app, olivia, 'sara@kettle.test', 'Contributor');
    expect(sara.invitation).toMatchObject({
      email: 'sara@kettle.test',
      role: { name: 'Contributor' },
      expired: false,
      invitedBy: { id: olivia.userId, name: 'Olivia Owner' },
    });

    const found = await lookup(sara.token).expect(200);
    expect(found.body).toEqual({
      site: { name: 'Kettle & Crumb' },
      role: { name: 'Contributor' },
      email: 'sara@kettle.test',
      hasAccount: false,
      expiresAt: expect.any(String),
    });
    const expiresAt = Date.parse(found.body.expiresAt);
    expect(expiresAt).toBeGreaterThanOrEqual(before + SEVEN_DAYS_MS - 1000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + SEVEN_DAYS_MS + 1000);

    const joined = await accept({
      token: sara.token,
      name: 'Sara Sample',
      password: NEW_PASSWORD,
    }).expect(200);
    expect(joined.body).toMatchObject({
      accessToken: expect.any(String),
      tokenType: 'Bearer',
      expiresAt: expect.any(String),
      user: { email: 'sara@kettle.test', name: 'Sara Sample' },
    });
    expect(joined.body.memberships).toHaveLength(1);
    expect(joined.body.memberships[0]).toMatchObject({
      site: { id: olivia.siteId, name: 'Kettle & Crumb' },
      role: { name: 'Contributor' },
    });

    // The answer is a working sign-in.
    const me = await api()
      .get('/auth/me')
      .set({ Authorization: `Bearer ${joined.body.accessToken}` })
      .expect(200);
    expect(me.body.user.email).toBe('sara@kettle.test');

    const members = await api().get('/members').set(olivia.headers).expect(200);
    const row = members.body.members.find(
      (m: { email: string }) => m.email === 'sara@kettle.test',
    );
    expect(row).toMatchObject({
      name: 'Sara Sample',
      role: { name: 'Contributor' },
    });
    expect(members.body.invitations).toEqual([]);

    const login = await api()
      .post('/auth/login')
      .send({ email: 'sara@kettle.test', password: NEW_PASSWORD })
      .expect(200);
    expect(rolesBySite(login.body)).toEqual({
      [olivia.siteId]: 'Contributor',
    });
  });
});

describe('someone with an account', () => {
  it('[UC-UR-07] Sara, an Author on site B, joins site A as Editor with her own password: signed in on both, password, name and site-B role unchanged, a sent name ignored', async () => {
    const olivia = await kettle();
    const hana = await halden();
    const existing = await addMember(app, hana.siteId, {
      email: 'sara@kettle.test',
      name: 'Sara Sample',
      role: 'Author',
    });
    const [before] = await usersWithEmail('sara@kettle.test');

    const sara = await invite(app, olivia, 'sara@kettle.test', 'Editor');
    const found = await lookup(sara.token).expect(200);
    expect(found.body).toMatchObject({
      site: { name: 'Kettle & Crumb' },
      role: { name: 'Editor' },
      email: 'sara@kettle.test',
      hasAccount: true,
    });

    const joined = await accept({
      token: sara.token,
      password: TEST_PASSWORD,
      name: 'Somebody Else',
    }).expect(200);
    expect(joined.body.accessToken).toEqual(expect.any(String));
    expect(joined.body.user).toMatchObject({
      id: existing.userId,
      name: 'Sara Sample',
    });
    expect(rolesBySite(joined.body)).toEqual({
      [olivia.siteId]: 'Editor',
      [hana.siteId]: 'Author',
    });

    const after = await usersWithEmail('sara@kettle.test');
    expect(after).toEqual([before]);
    expect(await membershipsOf(existing.userId)).toEqual([
      { site_id: hana.siteId, role: 'Author' },
      { site_id: olivia.siteId, role: 'Editor' },
    ]);
    await api()
      .post('/auth/login')
      .send({ email: 'sara@kettle.test', password: TEST_PASSWORD })
      .expect(200);
  });
});

describe('one use only', () => {
  it('[UC-UR-10] two accepts with the same link at the same moment: exactly one succeeds, the other and a later third are 404, one account, one membership', async () => {
    const olivia = await kettle();
    const sara = await invite(app, olivia, 'sara@kettle.test', 'Contributor');
    const body = {
      token: sara.token,
      name: 'Sara Sample',
      password: NEW_PASSWORD,
    };

    const pair = await Promise.all([accept(body), accept(body)]);
    const statuses = pair.map((res) => res.status).sort();
    expect(statuses, JSON.stringify(pair.map((r) => r.body))).toEqual([
      200, 404,
    ]);
    const loser = pair.find((res) => res.status === 404)!;
    expect(loser.body.message).toBe(INVITE_GONE);

    const third = await accept(body).expect(404);
    expect(third.body.message).toBe(INVITE_GONE);

    const users = await usersWithEmail('sara@kettle.test');
    expect(users).toHaveLength(1);
    expect(await membershipsOf(users[0].id)).toEqual([
      { site_id: olivia.siteId, role: 'Contributor' },
    ]);
  });
});

describe('dead links', () => {
  it('[UC-UR-11] used, 7 days and 1 second old, cancelled and made-up links all get the same 404 on lookup and accept, and nothing is created; 6 days 23 hours old still works', async () => {
    const olivia = await kettle();

    const used = await invite(app, olivia, 'used@kettle.test', 'Viewer');
    await accept({
      token: used.token,
      name: 'Una Used',
      password: NEW_PASSWORD,
    }).expect(200);

    const expired = await invite(app, olivia, 'old@kettle.test', 'Viewer');
    await dataSource.query(
      `UPDATE invitations SET created_at = now() - interval '7 days 1 second',
              expires_at = now() - interval '1 second' WHERE id = $1`,
      [expired.id],
    );

    const cancelled = await invite(app, olivia, 'gone@kettle.test', 'Viewer');
    await api()
      .delete(`/invitations/${cancelled.id}`)
      .set(olivia.headers)
      .expect(204);

    const madeUp = randomBytes(32).toString('base64url');

    const nearlyOld = await invite(app, olivia, 'late@kettle.test', 'Viewer');
    await dataSource.query(
      `UPDATE invitations SET created_at = now() - interval '6 days 23 hours',
              expires_at = now() + interval '1 hour' WHERE id = $1`,
      [nearlyOld.id],
    );

    const before = await counts();
    const dead = {
      used: used.token,
      expired: expired.token,
      cancelled: cancelled.token,
      'made up': madeUp,
    };
    for (const [what, token] of Object.entries(dead)) {
      const found = await lookup(token);
      expect([what, found.status, found.body.message]).toEqual([
        what,
        404,
        INVITE_GONE,
      ]);
      const joined = await accept({
        token,
        name: 'Someone New',
        password: NEW_PASSWORD,
      });
      expect([what, joined.status, joined.body.message]).toEqual([
        what,
        404,
        INVITE_GONE,
      ]);
    }
    expect(await counts()).toEqual(before);
    expect(await usersWithEmail('old@kettle.test')).toEqual([]);
    expect(await usersWithEmail('gone@kettle.test')).toEqual([]);

    // The expired one is still listed for the Administrator, marked expired.
    const members = await api().get('/members').set(olivia.headers).expect(200);
    const listed = members.body.invitations.find(
      (i: { email: string }) => i.email === 'old@kettle.test',
    );
    expect(listed).toMatchObject({ expired: true });

    await lookup(nearlyOld.token).expect(200);
    await accept({
      token: nearlyOld.token,
      name: 'Lee Late',
      password: NEW_PASSWORD,
    }).expect(200);
  });
});

describe('accept input', () => {
  it('[UC-UR-13] a new account needs a 12–256 character password and a 1–100 character name (400s name the field); a <script> name is stored as typed; a missing or non-string token is a 400', async () => {
    const olivia = await kettle();
    const nina = await invite(app, olivia, 'nina@kettle.test', 'Contributor');
    await lookup(nina.token).expect(200);

    const good = {
      token: nina.token,
      name: 'Nina New',
      password: NEW_PASSWORD,
    };
    const bad: [string, object, string][] = [
      ['11-character password', { password: 'a'.repeat(11) }, 'password'],
      ['257-character password', { password: 'a'.repeat(257) }, 'password'],
      ['no password', { password: undefined }, 'password'],
      ['empty name', { name: '' }, 'name'],
      ['spaces-only name', { name: '    ' }, 'name'],
      ['no name', { name: undefined }, 'name'],
      ['101-character name', { name: 'n'.repeat(101) }, 'name'],
    ];
    for (const [what, change, field] of bad) {
      expectFieldError(await accept({ ...good, ...change }), field, what);
    }
    for (const token of [undefined, 42]) {
      expectFieldError(
        await accept({ ...good, token }),
        'token',
        `token ${token}`,
      );
      expect((await lookup(token)).status, `lookup token ${token}`).toBe(400);
    }
    expect(await usersWithEmail('nina@kettle.test')).toEqual([]);

    const scripted = '<script>alert("hi")</script> Nina';
    const joined = await accept({ ...good, name: scripted }).expect(200);
    expect(joined.body.user.name).toBe(scripted);
    const [stored] = await usersWithEmail('nina@kettle.test');
    expect(stored.name).toBe(scripted);
  });

  it('[UC-UR-13] a wrong password for an existing account is a 401 and the link still works; an account made between lookup and accept is a 409 and the invite still waits', async () => {
    const olivia = await kettle();
    const hana = await halden();
    await addMember(app, hana.siteId, {
      email: 'sara@kettle.test',
      name: 'Sara Sample',
      role: 'Author',
    });
    const sara = await invite(app, olivia, 'sara@kettle.test', 'Editor');
    await lookup(sara.token).expect(200);

    const wrong = await accept({
      token: sara.token,
      password: 'not her password',
    }).expect(401);
    expect(wrong.body.message).toBe('Invalid email or password');
    await lookup(sara.token).expect(200);
    await accept({ token: sara.token, password: TEST_PASSWORD }).expect(200);

    // Mia's invite is looked up while she has no account; then one appears before she accepts.
    const mia = await invite(app, olivia, 'mia@kettle.test', 'Viewer');
    const found = await lookup(mia.token).expect(200);
    expect(found.body.hasAccount).toBe(false);
    await seedUser(dataSource, {
      email: 'mia@kettle.test',
      name: 'Mia Meanwhile',
      password: TEST_PASSWORD,
    });

    const conflict = await accept({
      token: mia.token,
      name: 'Mia Mine',
      password: 'mia-chosen-password',
    }).expect(409);
    expect(conflict.body.message).toBe(
      'This email already has an account. Sign in to join.',
    );
    const still = await lookup(mia.token).expect(200);
    expect(still.body.hasAccount).toBe(true);
    const [miaUser] = await usersWithEmail('mia@kettle.test');
    expect(miaUser.name).toBe('Mia Meanwhile');
    expect(await membershipsOf(miaUser.id)).toEqual([]);
  });
});
