import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { Hostname, Site } from '../src/database/entities/index.js';
import { PlatformRepository } from '../src/platform/platform.repository.js';
import { SiteResolver } from '../src/sites/site-resolver.service.js';
import { createTestApp } from './support/app.js';
import { resetDatabase } from './support/database.js';
import { MALFORMED_HOSTS } from './support/hosts.js';
import { seedHostname, seedTwoSites } from './support/seed.js';

/**
 * `GET /sites/resolve?host=` (FND-04): the public website asks which site answers on an address,
 * with no login. Runs against real Postgres with both seeded sites, Corrick and Bakery, each given
 * its own name, theme and settings, so an answer carrying a field of the wrong site shows.
 *
 * The resolver caches per instance, so every test starts from a cold cache (`invalidateAll`), and
 * "the database was not asked" is counted with a pass-through spy on TypeORM's query logger.
 */

type Look = {
  theme: Record<string, unknown>;
  settings: Record<string, unknown>;
};
const CORRICK_LOOK: Look = {
  theme: { palette: 'forest' },
  settings: { footer: 'Since 1990' },
};
const BAKERY_LOOK: Look = {
  theme: { palette: 'honey' },
  settings: { footer: 'Fresh daily' },
};

/** The URL a client calls for a raw `host`: no query for `undefined`, `host` repeated for an array. */
function urlFor(raw: unknown): string {
  if (raw === undefined) return '/sites/resolve';
  const values = Array.isArray(raw) ? raw : [raw];
  const query = values
    .map((value) => `host=${encodeURIComponent(String(value))}`)
    .join('&');
  return `/sites/resolve?${query}`;
}

describe('GET /sites/resolve', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let resolver: SiteResolver;
  let corrick: Site;
  let bakery: Site;

  beforeAll(async () => {
    ({ app, dataSource } = await createTestApp());
    // Listening on a loopback port keeps supertest from opening and closing a listener of its own
    // around each request, which matters for the requests sent at the same time (UC-HR-03).
    await app.listen(0, '127.0.0.1');
    resolver = app.get(SiteResolver);
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
    resolver.invalidateAll(); // a cold cache: nothing the last test resolved is remembered
    const data = await seedTwoSites(dataSource);
    corrick = data.corrick.site;
    bakery = data.bakery.site;
  });

  afterAll(async () => {
    await app.close();
  });

  /** What the public site sends: a plain GET, no login, no other header. */
  const call = async (url: string) => request(app.getHttpServer()).get(url);
  const resolve = async (host: string) =>
    request(app.getHttpServer()).get('/sites/resolve').query({ host });

  /** Gives a seeded site a theme and settings, written straight to the table. */
  const dress = (site: Site, look: Look) =>
    dataSource.manager.update(Site, { id: site.id }, look as never);

  /** The whole answer the endpoint must give for `host`, canonical address defaulting to itself. */
  const answerFor = (
    site: Site,
    look: Look,
    host: string,
    canonicalHost = host,
  ) => ({
    site: { id: site.id, name: site.name, ...look },
    host,
    canonicalHost,
    isCanonical: host === canonicalHost,
  });

  /** Runs `call` and returns what it gave back and the SQL statements sent meanwhile. */
  async function withSqlCount<T>(
    run: () => Promise<T>,
  ): Promise<{ result: T; sql: string[] }> {
    const logQuery = vi.spyOn(dataSource.logger, 'logQuery');
    try {
      const result = await run();
      return { result, sql: logQuery.mock.calls.map(([sql]) => sql) };
    } finally {
      logQuery.mockRestore();
    }
  }

  /** Resolves each address in turn; for each, how many SQL statements it sent and what it said. */
  async function resolveAll(hosts: string[]) {
    const seen: Record<string, { sql: number; body: any }> = {};
    for (const host of hosts) {
      const { result, sql } = await withSqlCount(() => resolve(host));
      expect(result.status, host).toBe(200);
      seen[host] = { sql: sql.length, body: result.body };
    }
    return seen;
  }

  it('[UC-HR-01] resolves a registered address to its site, with no login', async () => {
    await seedHostname(dataSource, corrick.id, 'corrick.test', true);
    await dress(corrick, CORRICK_LOOK);

    const res = await resolve('corrick.test');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(answerFor(corrick, CORRICK_LOOK, 'corrick.test'));
  });

  it('[UC-HR-02] a second address resolves to the same site and says where the canonical one is', async () => {
    await seedHostname(dataSource, corrick.id, 'corrick.test', true);
    await seedHostname(dataSource, corrick.id, 'www.corrick.test');
    await dress(corrick, CORRICK_LOOK);

    const res = await resolve('www.corrick.test');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      answerFor(corrick, CORRICK_LOOK, 'www.corrick.test', 'corrick.test'),
    );
    expect(res.body.isCanonical).toBe(false);
  });

  it('[UC-HR-03] two sites stay apart, asked in turns and at the same time', async () => {
    await seedHostname(dataSource, corrick.id, 'corrick.test', true);
    await seedHostname(dataSource, bakery.id, 'bakery.test', true);
    await dress(corrick, CORRICK_LOOK);
    await dress(bakery, BAKERY_LOOK);
    const expected: Record<string, unknown> = {
      'corrick.test': answerFor(corrick, CORRICK_LOOK, 'corrick.test'),
      'bakery.test': answerFor(bakery, BAKERY_LOOK, 'bakery.test'),
    };

    // In turns, from a cold cache: the second and fourth answers come from the cache.
    for (const host of [
      'corrick.test',
      'bakery.test',
      'corrick.test',
      'bakery.test',
    ]) {
      const res = await resolve(host);
      expect(res.status, host).toBe(200);
      expect(res.body, host).toEqual(expected[host]);
    }

    // Both at once, from a cold cache again: lookups running side by side must not mix up.
    resolver.invalidateAll();
    const together = [
      'corrick.test',
      'bakery.test',
      'bakery.test',
      'corrick.test',
      'corrick.test',
      'bakery.test',
    ];
    const answers = await Promise.all(together.map((host) => resolve(host)));
    answers.forEach((res, i) => {
      expect(res.status, together[i]).toBe(200);
      expect(res.body, together[i]).toEqual(expected[together[i]]);
    });
  });

  it('[UC-HR-04] a site with no primary address treats the asked address as canonical', async () => {
    await seedHostname(dataSource, bakery.id, 'bakery.test');
    await seedHostname(dataSource, bakery.id, 'shop.bakery.test');
    await dress(bakery, BAKERY_LOOK);

    // Two addresses and none primary: each one is its own canonical address, not "the first".
    for (const host of ['bakery.test', 'shop.bakery.test']) {
      const res = await resolve(host);
      expect(res.status, host).toBe(200);
      expect(res.body, host).toEqual(
        answerFor(bakery, BAKERY_LOOK, host, host),
      );
      expect(res.body.isCanonical, host).toBe(true);
    }
  });

  it('[UC-HR-05] capital letters, a trailing dot and a port are ignored', async () => {
    await seedHostname(dataSource, corrick.id, 'corrick.test', true);
    await dress(corrick, CORRICK_LOOK);
    const expected = answerFor(corrick, CORRICK_LOOK, 'corrick.test');

    const typed = [
      'corrick.test',
      'Corrick.TEST',
      'corrick.test:3000',
      'corrick.test.',
      'CORRICK.test.:8080',
    ];
    for (const host of typed) {
      resolver.invalidateAll(); // each spelling goes through the lookup itself, not a cached entry
      const res = await resolve(host);
      expect(res.status, host).toBe(200);
      expect(res.body, host).toEqual(expected);
    }
  });

  it('[UC-HR-06] addresses are not guessed: no www added or removed, no parent or child domain matched', async () => {
    await seedHostname(dataSource, corrick.id, 'corrick.test', true);
    await seedHostname(dataSource, corrick.id, 'www.corrick.test');
    await seedHostname(dataSource, bakery.id, 'bakery.test', true);

    // Control: the registered addresses answer, so the 404s below are answers, not a missing route.
    const registered: [string, string][] = [
      ['corrick.test', corrick.id],
      ['www.corrick.test', corrick.id],
      ['bakery.test', bakery.id],
    ];
    for (const [host, siteId] of registered) {
      const res = await resolve(host);
      expect(res.status, host).toBe(200);
      expect(res.body.site.id, host).toBe(siteId);
    }

    for (const host of [
      'blog.corrick.test',
      'corrick.test.evil.test',
      'test',
      'www.bakery.test',
    ]) {
      const res = await resolve(host);
      expect(res.status, host).toBe(404);
      expect(res.body.site, host).toBeUndefined();
    }
  });

  it('[UC-HR-07] an unknown address is "not found", with an error message and no site data', async () => {
    await seedHostname(dataSource, corrick.id, 'corrick.test', true);
    // Control: the endpoint exists and knows Corrick, so the 404 below is an answer.
    expect((await resolve('corrick.test')).status).toBe(200);

    const res = await resolve('nobody.test');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      statusCode: 404,
      error: 'Not Found',
      message: expect.stringMatching(/\S/),
    });
  });

  it('[UC-HR-08] repeat lookups do not touch the database', async () => {
    await seedHostname(dataSource, corrick.id, 'corrick.test', true);
    await dress(corrick, CORRICK_LOOK);

    const first = await withSqlCount(() => resolve('corrick.test'));
    const again = await withSqlCount(() => resolve('corrick.test'));
    const otherCase = await withSqlCount(() => resolve('CORRICK.test'));

    expect(first.sql.length).toBeGreaterThan(0);
    expect(again.sql).toEqual([]);
    expect(otherCase.sql).toEqual([]);
    for (const { result } of [first, again, otherCase]) {
      expect(result.status).toBe(200);
      expect(result.body).toEqual(first.result.body);
    }
    expect(first.result.body).toEqual(
      answerFor(corrick, CORRICK_LOOK, 'corrick.test'),
    );
  });

  it('[UC-HR-11] invalidation makes a change visible at once, and only for what changed', async () => {
    await seedHostname(dataSource, corrick.id, 'corrick.test', true);
    await seedHostname(dataSource, corrick.id, 'www.corrick.test');
    await seedHostname(dataSource, bakery.id, 'bakery.test', true);
    await dress(corrick, CORRICK_LOOK);
    await dress(bakery, BAKERY_LOOK);
    const three = ['corrick.test', 'www.corrick.test', 'bakery.test'];

    // All three are cached: the first round asked the database, the second did not.
    const cold = await resolveAll(three);
    const warm = await resolveAll(three);
    for (const host of three) {
      expect(cold[host].sql, `${host} when cold`).toBeGreaterThan(0);
      expect(warm[host].sql, `${host} when cached`).toBe(0);
    }

    // Corrick's theme and addresses change: its primary address moves to the www one.
    const changedLook = { ...CORRICK_LOOK, theme: { palette: 'ocean' } };
    await dataSource.manager.update(
      Site,
      { id: corrick.id },
      { theme: changedLook.theme },
    );
    await dataSource.manager.update(
      Hostname,
      { siteId: corrick.id, hostname: 'corrick.test' },
      { isPrimary: false },
    );
    await dataSource.manager.update(
      Hostname,
      { siteId: corrick.id, hostname: 'www.corrick.test' },
      { isPrimary: true },
    );

    // invalidateSite: both Corrick addresses are looked up again and show the change, while
    // bakery.test is still served from the cache.
    resolver.invalidateSite(corrick.id);
    const afterSite = await resolveAll(three);
    expect(afterSite['corrick.test'].sql).toBeGreaterThan(0);
    expect(afterSite['www.corrick.test'].sql).toBeGreaterThan(0);
    expect(afterSite['bakery.test'].sql).toBe(0);
    expect(afterSite['corrick.test'].body).toEqual(
      answerFor(corrick, changedLook, 'corrick.test', 'www.corrick.test'),
    );
    expect(afterSite['www.corrick.test'].body).toEqual(
      answerFor(corrick, changedLook, 'www.corrick.test'),
    );
    expect(afterSite['bakery.test'].body).toEqual(
      answerFor(bakery, BAKERY_LOOK, 'bakery.test'),
    );

    // invalidateHost drops that address only.
    resolver.invalidateHost('bakery.test');
    const afterHost = await resolveAll(three);
    expect(afterHost['bakery.test'].sql).toBeGreaterThan(0);
    expect(afterHost['corrick.test'].sql).toBe(0);
    expect(afterHost['www.corrick.test'].sql).toBe(0);

    // invalidateAll drops all.
    resolver.invalidateAll();
    const afterAll = await resolveAll(three);
    for (const host of three) {
      expect(afterAll[host].sql, `${host} after invalidateAll`).toBeGreaterThan(
        0,
      );
    }
  });

  it('[UC-HR-15] a missing or malformed address is a 400 with a clear message, and the database is not asked', async () => {
    // A real address the bad ones are made to resemble: a lenient check would resolve some of
    // them (a port suffix, a path, the Kelvin sign) to Corrick instead of refusing them.
    await seedHostname(dataSource, corrick.id, 'corrick.test', true);

    const { result: answered, sql } = await withSqlCount(async () => {
      const seen: { what: string; status: number; body: any }[] = [];
      for (const { what, raw } of MALFORMED_HOSTS) {
        const res = await call(urlFor(raw));
        seen.push({ what, status: res.status, body: res.body });
      }
      return seen;
    });

    for (const { what, status, body } of answered) {
      expect(status, what).toBe(400);
      expect(body, what).toMatchObject({
        statusCode: 400,
        error: 'Bad Request',
      });
      expect(body.message, what).toEqual(expect.stringMatching(/\S/));
    }
    expect(sql).toEqual([]);
  });

  it('[UC-HR-17] the public answer holds only public fields, and needs no login', async () => {
    await seedHostname(dataSource, corrick.id, 'corrick.test', true);
    await seedHostname(dataSource, corrick.id, 'www.corrick.test');
    await dress(corrick, CORRICK_LOOK);

    for (const host of ['corrick.test', 'www.corrick.test']) {
      const res = await resolve(host); // no Authorization header

      expect(res.status, host).toBe(200);
      expect(Object.keys(res.body).sort(), host).toEqual([
        'canonicalHost',
        'host',
        'isCanonical',
        'site',
      ]);
      expect(Object.keys(res.body.site).sort(), host).toEqual([
        'id',
        'name',
        'settings',
        'theme',
      ]);
      expect(JSON.stringify(res.body), host).not.toContain(
        corrick.organizationId,
      );
    }

    // No list of the site's other addresses: the answer for corrick.test never names the www one.
    const primary = await resolve('corrick.test');
    expect(JSON.stringify(primary.body)).not.toContain('www.corrick.test');
  });

  it('[UC-HR-19] a newly added address works at once after invalidateSite, with no invalidateHost', async () => {
    await seedHostname(dataSource, corrick.id, 'corrick.test', true);
    await dress(corrick, CORRICK_LOOK);

    // No site answers on new.test yet, and that "unknown" is now remembered.
    expect((await resolve('new.test')).status).toBe(404);

    // An admin adds new.test to Corrick. The remembered "unknown" still hides it: the answer is
    // 404 with no SQL, which is what makes the step below worth testing.
    await seedHostname(dataSource, corrick.id, 'new.test');
    const hidden = await withSqlCount(() => resolve('new.test'));
    expect(hidden.sql).toEqual([]);
    expect(hidden.result.status).toBe(404);

    // The one rule, "call invalidateSite after changing a site", is enough.
    resolver.invalidateSite(corrick.id);
    const res = await resolve('new.test');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      answerFor(corrick, CORRICK_LOOK, 'new.test', 'corrick.test'),
    );
  });

  it('[UC-HR-18] the rest of the app still works, the route exists, and the platform desk has exactly its four known methods', async () => {
    const health = await call('/health');
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({ status: 'ok', database: 'up' });

    const root = await call('/');
    expect(root.status).toBe(200);
    expect(root.body).toEqual({
      service: 'cms-api',
      version: expect.any(String),
    });

    // The route exists: with no host it answers 400, where an unknown route would answer 404.
    const noHost = await call('/sites/resolve');
    expect(noHost.status).toBe(400);

    const methods = Object.getOwnPropertyNames(PlatformRepository.prototype)
      .filter((name) => name !== 'constructor')
      .sort();
    // Two lookups added by auth (FND-05); the same list test/platform-repository.spec.ts pins.
    expect(methods).toEqual([
      'findMembershipsByUserId',
      'findSiteByHostname',
      'findUserByEmail',
      'findUserById',
    ]);
  });
});
