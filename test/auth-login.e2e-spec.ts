import type { INestApplication } from '@nestjs/common';
import { decodeJwt, decodeProtectedHeader, jwtVerify } from 'jose';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { Permission } from '../src/auth/permission.js';
import { createTestApp } from './support/app.js';
import { resetDatabase } from './support/database.js';
import {
  seedAuthWorld,
  TEST_PASSWORD,
  type AuthWorld,
} from './support/seed.js';
import { withSqlCount } from './support/sql-count.js';
import { appSecret } from './support/tokens.js';

/**
 * `POST /auth/login` (FND-05), against real Postgres. The world is the one in the use cases:
 * Ayesha (Editor on Corrick), Dana (Admin on Corrick, Contributor on Bakery), Chen (no site), all
 * with the same real password, hashed by the real `PasswordService`. "The database was not asked"
 * is counted with a pass-through spy on TypeORM's query logger.
 */

const WEEK_SECONDS = 7 * 24 * 60 * 60;
const AYESHA = { email: 'ayesha@corrick.test', password: TEST_PASSWORD };

/**
 * A well-formed address of exactly `length` characters: a 64-character local part and a domain of
 * labels of at most 63, so that only its length can make it wrong.
 */
function emailOfLength(length: number): string {
  const lastLabel = length - 65 - (63 + 1 + 63 + 1 + '.test'.length);
  return `${'a'.repeat(64)}@${'b'.repeat(63)}.${'b'.repeat(63)}.${'b'.repeat(lastLabel)}.test`;
}

describe('POST /auth/login', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let world: AuthWorld;

  beforeAll(async () => {
    ({ app, dataSource } = await createTestApp());
    // Listening on a loopback port keeps supertest from opening and closing a listener of its own around
    // each request: with several requests in a row that race sometimes ends in "socket hang up".
    await app.listen(0, '127.0.0.1');
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
    world = await seedAuthWorld(dataSource);
  });

  afterAll(async () => {
    await app.close();
  });

  /** What a client sends: a JSON body, or nothing at all when `body` is left out. */
  const login = (body?: unknown) => {
    const req = request(app.getHttpServer()).post('/auth/login');
    return body === undefined ? req : req.send(body as object);
  };

  it('[UC-AU-01] signing in with the right email and password', async () => {
    const { ayesha, corrick } = world;
    const before = Date.now();

    const res = await login(AYESHA);
    const after = Date.now();

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual([
      'accessToken',
      'expiresAt',
      'memberships',
      'tokenType',
      'user',
    ]);
    expect(res.body.tokenType).toBe('Bearer');
    expect(res.body.user).toEqual({
      id: ayesha.id,
      email: 'ayesha@corrick.test',
      name: 'Ayesha',
    });
    expect(res.body.memberships).toEqual([
      {
        site: {
          id: corrick.site.id,
          name: 'Corrick',
          primaryHost: 'corrick.test',
        },
        role: { id: corrick.editor.id, name: 'Editor' },
        permissions: [Permission.ContentCreate, Permission.ContentPublish],
      },
    ]);

    // The token is genuine: signed with the configured secret, and it names her.
    const { payload } = await jwtVerify(res.body.accessToken, appSecret(), {
      algorithms: ['HS256'],
    });
    expect(payload.sub).toBe(ayesha.id);

    // `expiresAt` is an ISO time about one lifetime from now (a token counts whole seconds).
    expect(new Date(res.body.expiresAt).toISOString()).toBe(res.body.expiresAt);
    const expiresAt = Date.parse(res.body.expiresAt);
    expect(expiresAt).toBeGreaterThanOrEqual(
      before + WEEK_SECONDS * 1000 - 2000,
    );
    expect(expiresAt).toBeLessThanOrEqual(after + WEEK_SECONDS * 1000 + 2000);

    // No password hash, and no field about passwords at all, anywhere in the answer.
    const { accessToken: _token, ...rest } = res.body;
    const text = JSON.stringify(rest);
    expect(text).not.toContain(ayesha.passwordHash);
    expect(text).not.toMatch(/scrypt|password/i);
  });

  it('[UC-AU-02] the email is forgiving, the password is not', async () => {
    const { ayesha, corrick } = world;

    const res = await login({ ...AYESHA, email: ' Ayesha@Corrick.TEST ' });

    expect(res.status).toBe(200);
    expect(res.body.user).toEqual({
      id: ayesha.id,
      email: 'ayesha@corrick.test',
      name: 'Ayesha',
    });
    expect(res.body.memberships).toEqual([
      {
        site: {
          id: corrick.site.id,
          name: 'Corrick',
          primaryHost: 'corrick.test',
        },
        role: { id: corrick.editor.id, name: 'Editor' },
        permissions: corrick.editor.permissions,
      },
    ]);
    expect(decodeJwt(res.body.accessToken).sub).toBe(ayesha.id);

    // A space at either end of the password makes it a different password.
    for (const password of [`${TEST_PASSWORD} `, ` ${TEST_PASSWORD}`]) {
      const refused = await login({ ...AYESHA, password });
      expect(refused.status, JSON.stringify(password)).toBe(401);
      expect(
        refused.body.accessToken,
        JSON.stringify(password),
      ).toBeUndefined();
    }
  });

  it('[UC-SP-01] each site comes with its main web address, so the admin can link to it', async () => {
    const { dana } = world;

    const res = await login({ email: dana.email, password: TEST_PASSWORD });

    // Corrick answers on corrick.test and www.corrick.test: only the main one is given. Bakery has none.
    expect(res.status).toBe(200);
    const hosts = (
      res.body.memberships as {
        site: { name: string; primaryHost: string | null };
      }[]
    ).map((m) => [m.site.name, m.site.primaryHost]);
    expect(hosts).toEqual([
      ['Bakery', null],
      ['Corrick', 'corrick.test'],
    ]);
  });

  it('[UC-AU-03] memberships come from every site the user belongs to, and may be none', async () => {
    const { dana, chen, corrick, bakery } = world;

    const asDana = await login({ email: dana.email, password: TEST_PASSWORD });
    const asChen = await login({ email: chen.email, password: TEST_PASSWORD });

    // Ordered by site name, each site with its own role and that role's permissions.
    expect(asDana.status).toBe(200);
    expect(asDana.body.memberships).toEqual([
      {
        site: { id: bakery.site.id, name: 'Bakery', primaryHost: null },
        role: { id: bakery.contributor.id, name: 'Contributor' },
        permissions: [Permission.ContentCreate],
      },
      {
        site: {
          id: corrick.site.id,
          name: 'Corrick',
          primaryHost: 'corrick.test',
        },
        role: { id: corrick.admin.id, name: 'Admin' },
        permissions: corrick.admin.permissions,
      },
    ]);

    // Chen belongs nowhere, and that is no reason to refuse him.
    expect(asChen.status).toBe(200);
    expect(asChen.body.user).toEqual({
      id: chen.id,
      email: 'chen@nowhere.test',
      name: 'Chen',
    });
    expect(asChen.body.memberships).toEqual([]);
    expect(asChen.body.accessToken).toEqual(expect.any(String));
  });

  it('[UC-AU-05] a wrong password and an unknown email look the same', async () => {
    const wrongPassword = await login({
      ...AYESHA,
      password: 'not the password',
    });
    const unknownEmail = await login({
      email: 'ghost@nowhere.test',
      password: TEST_PASSWORD,
    });

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(wrongPassword.body.message).toBe('Invalid email or password');
    expect(unknownEmail.body).toEqual(wrongPassword.body);
    for (const res of [wrongPassword, unknownEmail]) {
      expect(res.body.accessToken).toBeUndefined();
      expect(res.body.user).toBeUndefined();
    }
  });

  it('[UC-AU-07] a malformed login request is a 400, and the database is not asked', async () => {
    const email254 = emailOfLength(254);
    const email255 = emailOfLength(255);
    expect(email254).toHaveLength(254);
    expect(email255).toHaveLength(255);

    const bad: { what: string; body?: unknown }[] = [
      { what: 'no body at all' },
      { what: 'an empty body', body: {} },
      { what: 'no email', body: { password: TEST_PASSWORD } },
      { what: 'no password', body: { email: AYESHA.email } },
      { what: 'an empty password', body: { ...AYESHA, password: '' } },
      {
        what: 'an email that is not a string',
        body: { ...AYESHA, email: 12345 },
      },
      {
        what: 'an array as the email',
        body: { ...AYESHA, email: [AYESHA.email] },
      },
      {
        what: 'an email without an @',
        body: { ...AYESHA, email: 'ayesha.corrick.test' },
      },
      {
        what: 'an email with a NUL character',
        body: { ...AYESHA, email: 'ayesha\u0000@corrick.test' },
      },
      {
        what: 'a password of 257 characters',
        body: { ...AYESHA, password: 'p'.repeat(257) },
      },
      {
        what: 'an email of 255 characters',
        body: { ...AYESHA, email: email255 },
      },
    ];

    const { result: answers, sql } = await withSqlCount(
      dataSource,
      async () => {
        const seen: { what: string; status: number; body: any }[] = [];
        for (const { what, body } of bad) {
          const res = await login(body);
          seen.push({ what, status: res.status, body: res.body });
        }
        return seen;
      },
    );

    for (const { what, status, body } of answers) {
      expect(status, what).toBe(400);
      expect(body.accessToken, what).toBeUndefined();
    }
    expect(sql).toEqual([]);

    // The limits sit exactly where the rules put them: a 254-character address and a 256-character
    // password are fine to ask about (they are not an account, so 401).
    expect((await login({ email: email254, password: 'p' })).status).toBe(401);
    expect((await login({ ...AYESHA, password: 'p'.repeat(256) })).status).toBe(
      401,
    );

    // Control: a good request works, and it does ask the database, so the empty count above was
    // the 400s, not a blind spy.
    const control = await withSqlCount(dataSource, () => login(AYESHA));
    expect(control.result.status).toBe(200);
    expect(control.sql.length).toBeGreaterThan(0);
  });

  it('[UC-AU-10] the token holds the user id and two dates, nothing else, for the configured lifetime', async () => {
    const before = Date.now();
    const res = await login(AYESHA);
    const after = Date.now();
    expect(res.status).toBe(200);

    const token: string = res.body.accessToken;
    expect(decodeProtectedHeader(token).alg).toBe('HS256');

    const claims = decodeJwt(token);
    // No email, name or permissions: what she may do is looked up on each request.
    expect(Object.keys(claims).sort()).toEqual(['exp', 'iat', 'sub']);
    expect(claims.sub).toBe(world.ayesha.id);
    expect(claims.exp! - claims.iat!).toBe(WEEK_SECONDS);
    expect(claims.iat! * 1000).toBeGreaterThanOrEqual(before - 1000);
    expect(claims.iat! * 1000).toBeLessThanOrEqual(after + 1000);
  });
});
