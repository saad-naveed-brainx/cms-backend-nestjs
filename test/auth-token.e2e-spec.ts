import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { Permission } from '../src/auth/permission.js';
import { Role, User } from '../src/database/entities/index.js';
import { createTestApp } from './support/app.js';
import { resetDatabase } from './support/database.js';
import { seedAuthWorld, type AuthWorld } from './support/seed.js';
import { withSqlCount } from './support/sql-count.js';
import { badTokens, signTestToken } from './support/tokens.js';

/**
 * `GET /auth/me` and the token guard in front of it (FND-05), against real Postgres. Tokens are
 * built here with `jose`, not by the login step, so a failure points at the guard and not at the
 * code that issues tokens. "Never touched the database" is counted with a pass-through spy on
 * TypeORM's query logger.
 */

describe('GET /auth/me and the token guard', () => {
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

  /** `GET /auth/me`, with this exact `Authorization` header or none. */
  const me = (authorization?: string) => {
    const req = request(app.getHttpServer()).get('/auth/me');
    return authorization === undefined
      ? req
      : req.set('Authorization', authorization);
  };
  const bearerFor = async (userId: string) =>
    `Bearer ${await signTestToken({ sub: userId })}`;

  it('[UC-AU-04] /auth/me reads fresh data, so changes show without a new login', async () => {
    const { ayesha, corrick } = world;
    const authorization = await bearerFor(ayesha.id);

    const first = await me(authorization);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({
      user: { id: ayesha.id, email: 'ayesha@corrick.test', name: 'Ayesha' },
      memberships: [
        {
          site: {
            id: corrick.site.id,
            name: 'Corrick',
            primaryHost: 'corrick.test',
          },
          role: { id: corrick.editor.id, name: 'Editor' },
          permissions: [Permission.ContentCreate, Permission.ContentPublish],
        },
      ],
    });

    // Her role's permissions change and her name is edited, straight in the database.
    const changed = [
      Permission.ContentCreate,
      Permission.ContentDelete,
      Permission.MediaUpload,
    ];
    await dataSource.manager.update(
      Role,
      { id: corrick.editor.id },
      { permissions: changed },
    );
    await dataSource.manager.update(
      User,
      { id: ayesha.id },
      { name: 'Ayesha Khan' },
    );

    // The same token, no new login: the answer is the current data.
    const second = await me(authorization);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({
      user: {
        id: ayesha.id,
        email: 'ayesha@corrick.test',
        name: 'Ayesha Khan',
      },
      memberships: [
        {
          site: {
            id: corrick.site.id,
            name: 'Corrick',
            primaryHost: 'corrick.test',
          },
          role: { id: corrick.editor.id, name: 'Editor' },
          permissions: changed,
        },
      ],
    });
    expect(JSON.stringify(second.body)).not.toContain(ayesha.passwordHash);
  });

  it('[UC-AU-08] bad tokens are a 401 with one and the same body, and never reach the database', async () => {
    const { ayesha } = world;
    const valid = await signTestToken({ sub: ayesha.id });

    const headers: { what: string; authorization?: string }[] = [
      { what: 'no Authorization header' },
      { what: 'Basic credentials', authorization: 'Basic abc' },
      { what: 'Bearer with nothing after it', authorization: 'Bearer' },
      { what: 'a good token without the word Bearer', authorization: valid },
      ...(await badTokens(ayesha.id)).map(({ what, token }) => ({
        what,
        authorization: `Bearer ${token}`,
      })),
    ];

    const { result: answers, sql } = await withSqlCount(
      dataSource,
      async () => {
        const seen: { what: string; status: number; body: any }[] = [];
        for (const { what, authorization } of headers) {
          const res = await me(authorization);
          seen.push({ what, status: res.status, body: res.body });
        }
        return seen;
      },
    );

    for (const { what, status, body } of answers) {
      expect(status, what).toBe(401);
      expect(body, what).toEqual(answers[0].body); // the same body for every kind of failure
      expect(body.user, what).toBeUndefined();
    }
    expect(sql).toEqual([]);

    // Control: the same route does answer for a good token, the scheme word is not case-sensitive,
    // and this time the database is asked, so the empty count above was the 401s, not a blind spy.
    for (const scheme of ['Bearer', 'bearer', 'BEARER']) {
      const { result: res, sql: asked } = await withSqlCount(dataSource, () =>
        me(`${scheme} ${valid}`),
      );
      expect(res.status, scheme).toBe(200);
      expect(res.body.user.id, scheme).toBe(ayesha.id);
      expect(asked.length, scheme).toBeGreaterThan(0);
    }
  });

  it('[UC-AU-09] a valid token for a user that no longer exists is a 401', async () => {
    const { ayesha } = world;
    const authorization = await bearerFor(ayesha.id);
    expect((await me(authorization)).status).toBe(200); // control: it works while she exists

    await dataSource.manager.delete(User, { id: ayesha.id });

    // Same token, still signed and unexpired: the account behind it is gone.
    const res = await me(authorization);
    expect(res.status).toBe(401);
    expect(res.body.user).toBeUndefined();
  });
});
