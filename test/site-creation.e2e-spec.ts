import { Permission } from '../src/auth/permission.js';
import { ProvisioningService } from '../src/provisioning/provisioning.service.js';
import {
  buildContentWorld,
  type ContentWorld,
  type Who,
} from './support/content-world.js';
import { rowCounts } from './support/tenant.js';

/**
 * Creating a site from the admin (GOV-08a) through the real routes: real clients, real sign-ins,
 * and the real public lookup to see that a new address answers. Nothing is mocked.
 */

// Making the clients hashes with production-cost scrypt (about 0.2 s each).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

let world: ContentWorld;

beforeAll(async () => {
  world = await buildContentWorld();
});

afterAll(async () => {
  await world.close();
});

/** Only the sign-in: creating a site is about the person, not about one site. */
const signedIn = (who: Who) => ({ Authorization: who.headers.Authorization });
const createSite = (who: Who, body: unknown) =>
  world
    .api()
    .post('/sites')
    .set(signedIn(who))
    .send(body as object);
const organizationsOf = async (who: Who) =>
  (await world.api().get('/organizations').set(signedIn(who)).expect(200)).body
    .items as { id: string; name: string }[];

describe('creating a site', () => {
  it('[UC-RS-08] an organisation owner creates a site with its addresses, role, membership and types, and its address answers at once', async () => {
    const { api, orchard, dataSource } = world;

    // The new address is asked about first: "unknown" is remembered for a while, and creating a
    // site must make the lookup forget it.
    await api().get('/sites/resolve?host=cafe.test').expect(404);

    const res = await createSite(orchard.admin, {
      name: '  Orchard Cafe ',
      hostnames: ['Cafe.TEST', 'www.cafe.test', 'cafe.test:3000'],
    }).expect(201);
    expect(res.body).toMatchObject({
      organization: { name: 'Orchard Holdings' },
      site: { name: 'Orchard Cafe' },
      hostnames: ['cafe.test', 'www.cafe.test'],
      membership: {
        site: { name: 'Orchard Cafe' },
        role: { name: 'Administrator' },
        permissions: Object.values(Permission),
      },
    });
    const siteId = res.body.site.id as string;

    const [site] = await dataSource.query(
      'SELECT name, theme, settings FROM sites WHERE id = $1',
      [siteId],
    );
    expect(site).toEqual({ name: 'Orchard Cafe', theme: {}, settings: {} });
    expect(
      await dataSource.query(
        'SELECT hostname, is_primary FROM hostnames WHERE site_id = $1 ORDER BY hostname',
        [siteId],
      ),
    ).toEqual([
      { hostname: 'cafe.test', is_primary: true },
      { hostname: 'www.cafe.test', is_primary: false },
    ]);
    const [role] = await dataSource.query(
      'SELECT name, permissions::text[] AS permissions FROM roles WHERE site_id = $1',
      [siteId],
    );
    expect(role.name).toBe('Administrator');
    expect([...role.permissions].sort()).toEqual(
      Object.values(Permission).sort(),
    );
    expect(
      await dataSource.query(
        'SELECT user_id FROM site_members WHERE site_id = $1',
        [siteId],
      ),
    ).toEqual([{ user_id: orchard.admin.userId }]);
    expect(
      (
        await dataSource.query(
          'SELECT slug FROM content_types WHERE site_id = $1 ORDER BY slug',
          [siteId],
        )
      ).map((row: { slug: string }) => row.slug),
    ).toEqual(['page', 'post']);

    // The person's next sign-in lists the new site, and the public lookup finds both addresses.
    const login = await api()
      .post('/auth/login')
      .send({
        email: 'olivia@orchard.test',
        password: 'orchard-admin-password',
      })
      .expect(200);
    expect(
      login.body.memberships.map(
        (m: { site: { name: string } }) => m.site.name,
      ),
    ).toContain('Orchard Cafe');

    const found = await api().get('/sites/resolve?host=cafe.test').expect(200);
    expect(found.body).toMatchObject({
      site: { id: siteId, name: 'Orchard Cafe' },
      isCanonical: true,
    });
    const alias = await api()
      .get('/sites/resolve?host=www.cafe.test')
      .expect(200);
    expect(alias.body).toMatchObject({
      canonicalHost: 'cafe.test',
      isCanonical: false,
    });
  });

  it('[UC-RS-09] which organisation: the only one you own, the one you name, and never one that is not yours', async () => {
    const { orchard, maple, dataSource } = world;

    // Mark owns one organisation, so he need not name it.
    const [markOrg] = await organizationsOf(maple.admin);
    const created = await createSite(maple.admin, {
      name: 'Maple Cafe',
      hostnames: ['maplecafe.test'],
    }).expect(201);
    expect(created.body.organization).toEqual(markOrg);

    // Olivia gets a second organisation (a second tenant for the same person) and must now say which.
    await world.app.get(ProvisioningService).provisionTenant({
      organizationName: 'Orchard Second Ltd',
      siteName: 'Orchard Annex',
      hostnames: ['annex.test'],
      admin: { email: 'olivia@orchard.test', name: 'Olivia Orchard' },
    });
    const mine = await organizationsOf(orchard.admin);
    expect(mine.map((organization) => organization.name).sort()).toEqual([
      'Orchard Holdings',
      'Orchard Second Ltd',
    ]);

    const before = await rowCounts(dataSource);
    const unnamed = await createSite(orchard.admin, {
      name: 'Nowhere',
      hostnames: ['nowhere.test'],
    }).expect(400);
    expect(unnamed.body.errors.join()).toContain('organizationId');
    // Someone else's organisation, and members who own none.
    await createSite(orchard.admin, {
      name: 'Hijack',
      hostnames: ['hijack.test'],
      organizationId: markOrg.id,
    }).expect(403);
    await createSite(orchard.author, {
      name: 'Nope',
      hostnames: ['nope.test'],
    }).expect(403);
    await createSite(orchard.viewer, {
      name: 'Nope',
      hostnames: ['nope.test'],
      organizationId: mine[0].id,
    }).expect(403);
    expect(await rowCounts(dataSource)).toEqual(before);

    const second = mine.find((item) => item.name === 'Orchard Second Ltd');
    const named = await createSite(orchard.admin, {
      name: 'Orchard Annex Two',
      hostnames: ['annex2.test'],
      organizationId: second?.id,
    }).expect(201);
    expect(named.body.organization).toEqual(second);
  });

  it('[UC-RS-10] refuses bad input with the problems listed by field, and a taken address with a 409, and creates nothing', async () => {
    const { maple, dataSource, api } = world;
    const before = await rowCounts(dataSource);
    const ok = { name: 'Fine', hostnames: ['fine.test'] };

    const bad: [string, unknown][] = [
      ['no name', { hostnames: ['fine.test'] }],
      ['a blank name', { ...ok, name: '   ' }],
      ['a 121-character name', { ...ok, name: 'n'.repeat(121) }],
      ['no addresses', { name: 'Fine' }],
      ['an empty address list', { ...ok, hostnames: [] }],
      [
        '11 addresses',
        {
          ...ok,
          hostnames: Array.from({ length: 11 }, (_, n) => `h${n}.test`),
        },
      ],
      ['an address that is not a host', { ...ok, hostnames: ['a b.test'] }],
      ['an address with a slash', { ...ok, hostnames: ['a/b'] }],
      ['addresses that are not a list', { ...ok, hostnames: 'fine.test' }],
      ['an unknown field', { ...ok, siteId: maple.siteId }],
      ['a malformed organisation id', { ...ok, organizationId: 'not-a-uuid' }],
      ['a body that is a list', []],
    ];
    for (const [what, body] of bad) {
      const res = await createSite(maple.admin, body);
      expect(res.status, what).toBe(400);
      expect(res.body.message, what).toBe('Invalid request');
      expect(res.body.errors.length, what).toBeGreaterThan(0);
    }
    const slash = await createSite(maple.admin, {
      ...ok,
      hostnames: ['fine.test', 'a/b'],
    });
    expect(slash.body.errors.join()).toContain('hostnames.1');

    // An address another site holds, in any capitals, among good ones.
    const taken = await createSite(maple.admin, {
      name: 'Clash',
      hostnames: ['fresh.test', 'Orchard.TEST'],
    }).expect(409);
    expect(taken.body.message).toContain('orchard.test');

    expect(await rowCounts(dataSource)).toEqual(before);
    await api().post('/sites').send(ok).expect(401);
  });

  it('[UC-RS-11] lists the organisations you own, and only those', async () => {
    const { orchard, maple, author, api } = {
      ...world,
      author: world.orchard.author,
    };

    expect((await organizationsOf(maple.admin)).map((o) => o.name)).toEqual([
      'Maple Group',
    ]);
    expect((await organizationsOf(orchard.admin)).map((o) => o.name)).toContain(
      'Orchard Holdings',
    );
    expect(
      (await organizationsOf(orchard.admin)).map((o) => o.name),
    ).not.toContain('Maple Group');
    expect(await organizationsOf(author)).toEqual([]);
    await api().get('/organizations').expect(401);
  });
});
