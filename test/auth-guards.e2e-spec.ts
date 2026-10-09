import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { Permission } from '../src/auth/permission.js';
import { Role, SiteMember, type User } from '../src/database/entities/index.js';
import { createTestApp } from './support/app.js';
import { resetDatabase } from './support/database.js';
import { ProbeController } from './support/probe.controller.js';
import {
  seedAuthWorld,
  seedMembership,
  type AuthWorld,
} from './support/seed.js';
import { withSqlCount } from './support/sql-count.js';
import { signTestToken } from './support/tokens.js';

/**
 * The global guards (FND-05): a token for every route unless it is marked `@Public()`, and for a
 * site-scoped route a site named in `X-Site-Id` where the caller is a member, with the permissions
 * the route needs. They run against test-only routes (`test/support/probe.controller.ts`), one per
 * way the decorators combine, on the real app and real Postgres. Tokens are built with `jose`, so
 * a failure points at the guards and not at the login step. "No membership query ran" is counted
 * with a pass-through spy on TypeORM's query logger.
 */

describe('the auth guards', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let world: AuthWorld;

  beforeAll(async () => {
    ({ app, dataSource } = await createTestApp([ProbeController]));
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

  const bearerFor = async (user: User) =>
    `Bearer ${await signTestToken({ sub: user.id })}`;

  /**
   * A GET to a probe route, signed in as `as` (no token when left out), with `X-Site-Id` set to
   * `site` (no header when left out; an array sends the header once per value).
   */
  const call = async (
    path: string,
    { as, site }: { as?: User; site?: string | string[] } = {},
  ) => {
    const req = request(app.getHttpServer()).get(path);
    if (as) req.set('Authorization', await bearerFor(as));
    if (site !== undefined) req.set({ 'X-Site-Id': site });
    return req;
  };

  it('[UC-AU-11] a route nobody marked needs a login, and the real public routes do not', async () => {
    const { ayesha } = world;

    // Secure by default: no decorator, no entry without a token. With one it is just a route.
    expect((await call('/probe/undecorated')).status).toBe(401);
    const signedIn = await call('/probe/undecorated', { as: ayesha });
    expect(signedIn.status).toBe(200);

    // The token is checked before anything about the site: a site route with no token is a 401
    // whatever the header says (not a 400 for a missing header, not a 403 or a crash).
    const { corrick } = world;
    expect((await call('/probe/site')).status).toBe(401);
    expect(
      (await call('/probe/publish', { site: corrick.site.id })).status,
    ).toBe(401);

    // @Public() lets anyone in, and the token guard does not even look at a junk token.
    expect((await call('/probe/public')).status).toBe(200);
    const junk = await request(app.getHttpServer())
      .get('/probe/public')
      .set('Authorization', 'Bearer garbage');
    expect(junk.status).toBe(200);

    // The four real routes that must stay open, each answering by its own rules and none with a 401.
    const server = request(app.getHttpServer());
    const answers = {
      'GET /': (await server.get('/')).status,
      'GET /health': (await server.get('/health')).status,
      'GET /sites/resolve?host=x.test': (
        await server.get('/sites/resolve?host=x.test')
      ).status,
      'POST /auth/login': (await server.post('/auth/login')).status,
    };
    expect(answers).toEqual({
      'GET /': 200,
      'GET /health': 200,
      'GET /sites/resolve?host=x.test': 404, // no site answers there, and that is its own answer
      'POST /auth/login': 400, // no body
    });
  });

  it('[UC-AU-12] a member with the permission gets in, and the handler sees who and where', async () => {
    const { ayesha, corrick } = world;

    const res = await call('/probe/whoami', {
      as: ayesha,
      site: corrick.site.id,
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      user: { id: ayesha.id },
      site: {
        siteId: corrick.site.id,
        roleId: corrick.editor.id,
        roleName: 'Editor',
        permissions: corrick.editor.permissions,
      },
    });
  });

  it('[UC-AU-13] a missing or malformed X-Site-Id is a 400, and no membership query runs', async () => {
    const { ayesha, corrick } = world;
    const corrickId = corrick.site.id;

    const cases: { what: string; path?: string; site?: string | string[] }[] = [
      { what: 'no X-Site-Id header' },
      { what: 'an empty X-Site-Id', site: '' },
      { what: 'abc', site: 'abc' },
      // A plain trailing space never gets here: the HTTP layer strips it from a header value. A
      // non-breaking space is not stripped, so it stands in for "a uuid with something after it".
      {
        what: 'a uuid followed by a non-breaking space',
        site: `${corrickId} `,
      },
      { what: 'a uuid with one more character', site: `${corrickId}0` },
      { what: 'the same uuid sent twice', site: [corrickId, corrickId] },
      // A permission route is site-scoped too, so it asks for the header just the same.
      {
        what: 'no X-Site-Id on a route that needs a permission',
        path: '/probe/publish',
      },
    ];

    const { result: answers, sql } = await withSqlCount(
      dataSource,
      async () => {
        const seen: { what: string; status: number }[] = [];
        for (const { what, path = '/probe/site', site } of cases) {
          const res = await call(path, { as: ayesha, site });
          seen.push({ what, status: res.status });
        }
        return seen;
      },
    );

    for (const { what, status } of answers) expect(status, what).toBe(400);
    expect(sql).toEqual([]);

    // Control: with the header right, the same caller and route are let in, and this time the
    // membership is looked up, so the empty count above was the 400s, not a blind spy.
    const control = await withSqlCount(dataSource, () =>
      call('/probe/site', { as: ayesha, site: corrickId }),
    );
    expect(control.result.status).toBe(200);
    expect(control.sql.length).toBeGreaterThan(0);
  });

  it('[UC-AU-14] a site you do not belong to and one that does not exist look the same', async () => {
    const { ayesha, corrick, bakery } = world;

    const notAMember = await call('/probe/site', {
      as: ayesha,
      site: bakery.site.id,
    });
    const noSuchSite = await call('/probe/site', {
      as: ayesha,
      site: randomUUID(),
    });

    expect(notAMember.status).toBe(403);
    expect(noSuchSite.status).toBe(403);
    expect(noSuchSite.body).toEqual(notAMember.body);

    // Control: her own site is fine, so the 403s are about the site and not about her.
    expect(
      (await call('/probe/site', { as: ayesha, site: corrick.site.id })).status,
    ).toBe(200);
  });

  it('[UC-AU-15] a permission route needs every permission listed, and a plain site route needs only membership', async () => {
    const { ayesha, bilal, dana, corrick } = world;
    const corrickId = corrick.site.id;

    // Ayesha holds content.publish and content.create, and not settings.manage.
    const asAyesha = (path: string) =>
      call(path, { as: ayesha, site: corrickId });
    expect((await asAyesha('/probe/publish')).status).toBe(200);
    expect((await asAyesha('/probe/publish-and-settings')).status).toBe(403);
    expect((await asAyesha('/probe/site')).status).toBe(200);

    // Dana holds both, so the two-permission route lets her in: it is "all of them", not "none".
    const both = await call('/probe/publish-and-settings', {
      as: dana,
      site: corrickId,
    });
    expect(both.status).toBe(200);

    // Bilal is a member whose role grants nothing: any member passes @SiteScoped, no more.
    const asBilal = (path: string) =>
      call(path, { as: bilal, site: corrickId });
    expect((await asBilal('/probe/site')).status).toBe(200);
    expect((await asBilal('/probe/publish')).status).toBe(403);
  });

  it('[UC-AU-16] role and membership changes apply at once, with no new login', async () => {
    const { ayesha, corrick } = world;
    const publish = () =>
      call('/probe/publish', { as: ayesha, site: corrick.site.id });
    const member = () =>
      call('/probe/site', { as: ayesha, site: corrick.site.id });
    expect((await publish()).status).toBe(200);

    // content.publish is taken off her role: still a member, no longer allowed to publish.
    await dataSource.manager.update(
      Role,
      { id: corrick.editor.id },
      { permissions: [Permission.ContentCreate] },
    );
    expect((await publish()).status).toBe(403);
    expect((await member()).status).toBe(200);

    // Her membership is deleted: not a member any more, so even the plain route refuses her.
    await dataSource.manager.delete(SiteMember, {
      siteId: corrick.site.id,
      userId: ayesha.id,
    });
    expect((await publish()).status).toBe(403);
    expect((await member()).status).toBe(403);

    // A membership with the permission is added again: she is let in, on the very next request.
    await dataSource.manager.update(
      Role,
      { id: corrick.editor.id },
      { permissions: [Permission.ContentCreate, Permission.ContentPublish] },
    );
    await seedMembership(dataSource, {
      siteId: corrick.site.id,
      userId: ayesha.id,
      roleId: corrick.editor.id,
    });
    expect((await publish()).status).toBe(200);
    expect((await member()).status).toBe(200);
  });

  it('[UC-AU-17] the site comes from the header only: a siteId in the body or query is ignored', async () => {
    const { ayesha, dana, corrick, bakery } = world;
    const post = (path: string) => request(app.getHttpServer()).post(path);

    // Dana names Corrick in the header while the body and the query string both say Bakery.
    const res = await post(`/probe/echo?siteId=${bakery.site.id}`)
      .set('Authorization', await bearerFor(dana))
      .set('X-Site-Id', corrick.site.id)
      .send({ siteId: bakery.site.id });

    expect(res.status).toBe(200);
    expect(res.body.user).toEqual({ id: dana.id });
    expect(res.body.site).toEqual({
      siteId: corrick.site.id,
      roleId: corrick.admin.id,
      roleName: 'Admin',
      permissions: corrick.admin.permissions,
    });
    // The handler did receive the body and the query, so ignoring them was a decision.
    expect(res.body.body).toEqual({ siteId: bakery.site.id });
    expect(res.body.query).toEqual({ siteId: bakery.site.id });

    // With no header, a siteId in the body or the query cannot stand in for it.
    const noHeader = await post(`/probe/echo?siteId=${corrick.site.id}`)
      .set('Authorization', await bearerFor(dana))
      .send({ siteId: corrick.site.id });
    expect(noHeader.status).toBe(400);

    // Ayesha belongs to Corrick only. Bakery in the header is refused, though her token is valid
    // and her body and query name her own site.
    const refused = await post(`/probe/echo?siteId=${corrick.site.id}`)
      .set('Authorization', await bearerFor(ayesha))
      .set('X-Site-Id', bakery.site.id)
      .send({ siteId: corrick.site.id });
    expect(refused.status).toBe(403);
  });

  it('[UC-AU-20] the rest of the app still answers with no token, and the desk list is pinned', async () => {
    const { corrick } = world;
    // The auth world already gives Corrick its main address, corrick.test.
    const server = request(app.getHttpServer());

    const root = await server.get('/');
    expect(root.status).toBe(200);
    expect(root.body).toEqual({
      service: 'cms-api',
      version: expect.any(String),
    });

    const health = await server.get('/health');
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({ status: 'ok', database: 'up' });

    const known = await server
      .get('/sites/resolve')
      .query({ host: 'corrick.test' });
    expect(known.status).toBe(200);
    expect(known.body.site.id).toBe(corrick.site.id);
    expect(
      (await server.get('/sites/resolve').query({ host: 'x.test' })).status,
    ).toBe(404);

    // The desk's own list is pinned in test/platform-repository.spec.ts, also tagged UC-AU-20.
  });
});
