import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { createTestApp } from './support/app.js';
import { resetDatabase } from './support/database.js';
import {
  INVITE_GONE,
  SEVEN_DAYS_MS,
  expectFieldError,
  fingerprint,
  invite,
  newClient,
  roleIdOf,
} from './support/invitations.js';
import { addMember } from './support/members.js';

/**
 * Users and roles, T3 (`docs/features/users-roles/`), the Administrator's side of invitations:
 * making one, replacing it with a new invite or New link, the input rules, who may manage them, and
 * the link's secret never being stored or shown again. Real Postgres, real provisioning, real
 * sign-ins; nothing is mocked. Accepting is in `invitations-accept.e2e-spec.ts`.
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

/** Milliseconds between an ISO time and now plus seven days. */
const offFromSevenDays = (iso: string) =>
  Math.abs(Date.parse(iso) - (Date.now() + SEVEN_DAYS_MS));

async function invitationRows(siteId: string) {
  return dataSource.query<{ id: string; email: string }[]>(
    'SELECT id, email FROM invitations WHERE site_id = $1',
    [siteId],
  );
}

describe('replacing a waiting invite', () => {
  it('[UC-UR-09] inviting Sara again, then New link, leaves one waiting invite with the latest role, a fresh 7-day expiry and only the newest link working', async () => {
    const olivia = await kettle();
    const email = 'sara@kettle.test';

    const first = await invite(app, olivia, email, 'Contributor');
    // Age the waiting invite, so a fresh expiry is told apart from the old one.
    await dataSource.query(
      `UPDATE invitations SET created_at = now() - interval '5 days',
              expires_at = now() + interval '2 days' WHERE id = $1`,
      [first.id],
    );

    const second = await invite(app, olivia, email, 'Editor');
    expect(second.token).not.toBe(first.token);
    expect(second.invitation.role.name).toBe('Editor');
    expect(offFromSevenDays(second.invitation.expiresAt)).toBeLessThan(60_000);

    await dataSource.query(
      `UPDATE invitations SET created_at = now() - interval '5 days',
              expires_at = now() + interval '2 days' WHERE site_id = $1`,
      [olivia.siteId],
    );
    const renewed = await api()
      .post(`/invitations/${second.id}/renew`)
      .set(olivia.headers)
      .expect(200);
    const third = renewed.body.token as string;
    expect(typeof third).toBe('string');
    expect([first.token, second.token]).not.toContain(third);
    expect(renewed.body.invitation).toMatchObject({
      email,
      role: { name: 'Editor' },
      expired: false,
    });
    expect(offFromSevenDays(renewed.body.invitation.expiresAt)).toBeLessThan(
      60_000,
    );

    for (const dead of [first.token, second.token]) {
      const res = await lookup(dead).expect(404);
      expect(res.body.message).toBe(INVITE_GONE);
    }
    const alive = await lookup(third).expect(200);
    expect(alive.body).toMatchObject({ email, role: { name: 'Editor' } });
    expect(offFromSevenDays(alive.body.expiresAt)).toBeLessThan(60_000);

    const members = await api().get('/members').set(olivia.headers).expect(200);
    expect(members.body.invitations).toHaveLength(1);
    expect(members.body.invitations[0]).toMatchObject({
      email,
      role: { name: 'Editor' },
      expired: false,
    });
    expect(
      offFromSevenDays(members.body.invitations[0].expiresAt),
    ).toBeLessThan(60_000);
    expect(await invitationRows(olivia.siteId)).toHaveLength(1);
  });
});

describe('invite input', () => {
  it('[UC-UR-12] the email is trimmed and lower-cased; a bad email or role is a 400 naming the field; a member (any case) is a 409 and nothing is made', async () => {
    const olivia = await kettle();
    await addMember(app, olivia.siteId, {
      email: 'eddie@kettle.test',
      name: 'Eddie Editor',
      role: 'Editor',
    });
    const contributor = await roleIdOf(app, olivia.siteId, 'Contributor');
    const post = (body: object) =>
      api().post('/invitations').set(olivia.headers).send(body);

    const tidy = await post({
      email: '  Sara@Kettle.TEST ',
      roleId: contributor,
    });
    expect(tidy.status, JSON.stringify(tidy.body)).toBe(201);
    expect(tidy.body.invitation.email).toBe('sara@kettle.test');
    expect(
      (await invitationRows(olivia.siteId)).map((row) => row.email),
    ).toEqual(['sara@kettle.test']);

    const badEmails: [string, unknown][] = [
      ['not an email', 'not-an-email'],
      ['empty', ''],
      ['300 characters', `${'s'.repeat(289)}@kettle.test`],
      ['missing', undefined],
    ];
    for (const [what, email] of badEmails) {
      expectFieldError(
        await post({ email, roleId: contributor }),
        'email',
        what,
      );
    }
    const badRoles: [string, unknown][] = [
      ['a role id that does not exist', randomUUID()],
      ['not an id', 'not-a-role'],
    ];
    for (const [what, roleId] of badRoles) {
      expectFieldError(
        await post({ email: 'nora@kettle.test', roleId }),
        'roleId',
        what,
      );
    }

    const member = await post({
      email: 'Eddie@KETTLE.test',
      roleId: contributor,
    }).expect(409);
    expect(member.body.message).toBe(
      'eddie@kettle.test is already a member of this site.',
    );

    expect(
      (await invitationRows(olivia.siteId)).map((row) => row.email),
    ).toEqual(['sara@kettle.test']);
  });
});

describe('who may manage people', () => {
  it("[UC-UR-15] only site A's Administrators manage site A's people and invites: other roles and site B's Administrator get 403, no sign-in 401, site B's ids on site A 404 (a role 400) and site B is untouched", async () => {
    const olivia = await kettle();
    const hana = await halden();
    const siteA = olivia.siteId;
    const sara = await addMember(app, siteA, {
      email: 'sara@kettle.test',
      name: 'Sara Sample',
      role: 'Contributor',
    });
    const others = {
      Editor: await addMember(app, siteA, {
        email: 'eddie@kettle.test',
        name: 'Eddie Editor',
        role: 'Editor',
      }),
      Author: await addMember(app, siteA, {
        email: 'arthur@kettle.test',
        name: 'Arthur Author',
        role: 'Author',
      }),
      Contributor: await addMember(app, siteA, {
        email: 'cora@kettle.test',
        name: 'Cora Contributor',
        role: 'Contributor',
      }),
      Viewer: await addMember(app, siteA, {
        email: 'vic@kettle.test',
        name: 'Vic Viewer',
        role: 'Viewer',
      }),
    };
    const inviteA = await invite(app, olivia, 'nina@kettle.test', 'Author');
    const inviteB = await invite(app, hana, 'bo@halden.test', 'Editor');
    const editorA = await roleIdOf(app, siteA, 'Editor');

    /** Every people-managing call on site A, with these headers; returns each status. */
    const everyCall = async (headers: Record<string, string>) => ({
      'GET /members': (await api().get('/members').set(headers)).status,
      'POST /invitations': (
        await api()
          .post('/invitations')
          .set(headers)
          .send({ email: 'zed@kettle.test', roleId: editorA })
      ).status,
      'PATCH /members/:id': (
        await api()
          .patch(`/members/${sara.userId}`)
          .set(headers)
          .send({ roleId: editorA })
      ).status,
      'DELETE /members/:id': (
        await api().delete(`/members/${sara.userId}`).set(headers)
      ).status,
      'POST /invitations/:id/renew': (
        await api().post(`/invitations/${inviteA.id}/renew`).set(headers)
      ).status,
      'DELETE /invitations/:id': (
        await api().delete(`/invitations/${inviteA.id}`).set(headers)
      ).status,
    });
    const all = (status: number) => ({
      'GET /members': status,
      'POST /invitations': status,
      'PATCH /members/:id': status,
      'DELETE /members/:id': status,
      'POST /invitations/:id/renew': status,
      'DELETE /invitations/:id': status,
    });

    for (const [role, who] of Object.entries(others)) {
      expect({ role, ...(await everyCall(who.headers)) }).toEqual({
        role,
        ...all(403),
      });
    }
    expect(
      await everyCall({
        Authorization: hana.headers.Authorization,
        'X-Site-Id': siteA,
      }),
    ).toEqual(all(403));
    expect(await everyCall({ 'X-Site-Id': siteA })).toEqual(all(401));

    // Olivia, on site A, with site B's ids, or ids that are no one's.
    const asOlivia = olivia.headers;
    for (const id of [inviteB.id, randomUUID(), 'not-an-id']) {
      await api().post(`/invitations/${id}/renew`).set(asOlivia).expect(404);
      await api().delete(`/invitations/${id}`).set(asOlivia).expect(404);
    }
    for (const id of [hana.userId, randomUUID(), 'not-an-id']) {
      await api()
        .patch(`/members/${id}`)
        .set(asOlivia)
        .send({ roleId: editorA })
        .expect(404);
      await api().delete(`/members/${id}`).set(asOlivia).expect(404);
    }
    const editorB = await roleIdOf(app, hana.siteId, 'Editor');
    expectFieldError(
      await api()
        .post('/invitations')
        .set(asOlivia)
        .send({ email: 'zed@kettle.test', roleId: editorB }),
      'roleId',
      "site B's role on site A",
    );
    await api()
      .patch(`/members/${sara.userId}`)
      .set(asOlivia)
      .send({ roleId: editorB })
      .expect(400);

    // Nothing changed: site B's invite still works with its own link, Hana is still its Administrator,
    // and site A's invite and Sara are as they were.
    await lookup(inviteB.token).expect(200);
    await lookup(inviteA.token).expect(200);
    expect((await invitationRows(hana.siteId)).map((r) => r.email)).toEqual([
      'bo@halden.test',
    ]);
    expect((await invitationRows(siteA)).map((r) => r.email)).toEqual([
      'nina@kettle.test',
    ]);
    const bMembers = await api().get('/members').set(hana.headers).expect(200);
    expect(
      bMembers.body.members.map(
        (m: { userId: string; role: { name: string } }) => [
          m.userId,
          m.role.name,
        ],
      ),
    ).toEqual([[hana.userId, 'Administrator']]);
    const aMembers = await api().get('/members').set(asOlivia).expect(200);
    const saraRow = aMembers.body.members.find(
      (m: { userId: string }) => m.userId === sara.userId,
    );
    expect(saraRow.role.name).toBe('Contributor');
  });

  it('[UC-UR-15] GET /members answers the roles in definition order, the owner marked, waiting invites as InvitationViews and no password hash; the same role again is a no-op 200', async () => {
    const olivia = await kettle();
    const sara = await addMember(app, olivia.siteId, {
      email: 'sara@kettle.test',
      name: 'Sara Sample',
      role: 'Author',
    });
    const before = Date.now();
    const waiting = await invite(app, olivia, 'nina@kettle.test', 'Viewer');
    const authorRole = await roleIdOf(app, olivia.siteId, 'Author');

    const list = await api().get('/members').set(olivia.headers).expect(200);
    expect(list.body.roles.map((r: { name: string }) => r.name)).toEqual([
      'Administrator',
      'Editor',
      'Author',
      'Contributor',
      'Viewer',
    ]);
    expect(
      list.body.members.map((m: { userId: string; isOwner: boolean }) => [
        m.userId,
        m.isOwner,
      ]),
    ).toEqual([
      [olivia.userId, true],
      [sara.userId, false],
    ]);
    expect(list.body.invitations).toEqual([
      {
        id: waiting.id,
        email: 'nina@kettle.test',
        role: {
          id: await roleIdOf(app, olivia.siteId, 'Viewer'),
          name: 'Viewer',
        },
        expiresAt: expect.any(String),
        expired: false,
        invitedBy: { id: olivia.userId, name: 'Olivia Owner' },
        createdAt: expect.any(String),
      },
    ]);
    const [view] = list.body.invitations;
    expect(Date.parse(view.createdAt)).toBeGreaterThanOrEqual(before - 1000);
    expect(
      Math.abs(
        Date.parse(view.expiresAt) - Date.parse(view.createdAt) - SEVEN_DAYS_MS,
      ),
    ).toBeLessThan(1000);
    expect(JSON.stringify(list.body)).not.toMatch(/password/i);

    const same = await api()
      .patch(`/members/${sara.userId}`)
      .set(olivia.headers)
      .send({ roleId: authorRole })
      .expect(200);
    expect(same.body).toMatchObject({
      userId: sara.userId,
      role: { id: authorRole, name: 'Author' },
      isOwner: false,
    });
    const again = await api().get('/members').set(olivia.headers).expect(200);
    expect(again.body).toEqual(list.body);
  });
});

describe('the link secret', () => {
  it('[UC-UR-17] the secret is 43 base64url characters, stored only as its SHA-256 fingerprint, in no column, and in no later answer', async () => {
    const olivia = await kettle();
    const sara = await invite(app, olivia, 'sara@kettle.test', 'Editor');
    expect(sara.token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const [row] = await dataSource.query<Record<string, unknown>[]>(
      'SELECT * FROM invitations WHERE id = $1',
      [sara.id],
    );
    expect(row).toBeDefined();
    expect(row.token_hash).toBe(fingerprint(sara.token));
    expect(row.token_hash).not.toBe(sara.token);
    for (const [column, value] of Object.entries(row)) {
      const text =
        value instanceof Buffer
          ? `${value.toString('utf8')} ${value.toString('hex')} ${value.toString('base64url')}`
          : value instanceof Date
            ? value.toISOString()
            : JSON.stringify(value);
      expect(text, column).not.toContain(sara.token);
    }

    // Later answers: the list, making another invite, renewing that one, looking Sara's link up.
    const later: unknown[] = [];
    later.push(
      (await api().get('/members').set(olivia.headers).expect(200)).body,
    );
    const bo = await api()
      .post('/invitations')
      .set(olivia.headers)
      .send({
        email: 'bo@kettle.test',
        roleId: await roleIdOf(app, olivia.siteId, 'Viewer'),
      })
      .expect(201);
    later.push(bo.body);
    later.push(
      (
        await api()
          .post(`/invitations/${bo.body.invitation.id}/renew`)
          .set(olivia.headers)
          .expect(200)
      ).body,
    );
    later.push((await lookup(sara.token).expect(200)).body);
    later.push(
      (await api().get('/members').set(olivia.headers).expect(200)).body,
    );
    for (const body of later) {
      expect(JSON.stringify(body)).not.toContain(sara.token);
      expect(JSON.stringify(body)).not.toContain(fingerprint(sara.token));
    }
  });
});
