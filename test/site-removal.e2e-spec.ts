import { Permission } from '../src/auth/permission.js';
import {
  buildContentWorld,
  type ContentWorld,
  type Who,
} from './support/content-world.js';
import {
  TEST_PASSWORD,
  seedMembership,
  seedRole,
  seedUser,
} from './support/seed.js';

/**
 * Deleting a site (D-039) through the real routes: real clients, real sign-ins, the real address
 * lookup and public route, real Postgres cascades. Nothing is mocked. The two clients the world
 * builds are never deleted here: each test makes the sites it deletes.
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

/** Only the sign-in: deleting a site, like creating one, is about the person, not about one site. */
const signedIn = (who: Who) => ({ Authorization: who.headers.Authorization });

async function newSite(who: Who, name: string, hostnames: string[]) {
  const res = await world
    .api()
    .post('/sites')
    .set(signedIn(who))
    .send({ name, hostnames })
    .expect(201);
  return res.body.site.id as string;
}

const deleteSite = (who: Who, siteId: string) =>
  world.api().delete(`/sites/${siteId}`).set(signedIn(who));

/** How many rows each table holds for one site. */
async function rowsOf(siteId: string): Promise<Record<string, number>> {
  const tables = [
    'sites',
    'hostnames',
    'roles',
    'site_members',
    'content_types',
    'content',
  ];
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const column = table === 'sites' ? 'id' : 'site_id';
    const [{ n }] = await world.dataSource.query(
      `SELECT count(*)::int AS n FROM ${table} WHERE ${column} = $1`,
      [siteId],
    );
    counts[table] = n;
  }
  return counts;
}

describe('deleting a site', () => {
  it('[UC-SD-01] the owner deletes a site: everything it owns goes, its addresses stop answering at once and are free again, and the other sites are untouched', async () => {
    const { api, orchard, dataSource } = world;
    const siteId = await newSite(orchard.admin, 'Harbour Deli', [
      'deli.test',
      'www.deli.test',
    ]);

    // Links inside the site that point at each other: a child page, and a member on a role of its own.
    await dataSource.query(
      `INSERT INTO content (site_id, content_type_id, parent_id, title, slug, path)
         SELECT site_id, content_type_id, id, 'Our story', 'story', '/home/story'
           FROM content WHERE site_id = $1 AND path = '/home'`,
      [siteId],
    );
    const guest = await seedUser(dataSource, {
      email: 'gil@deli.test',
      name: 'Gil Guest',
      password: TEST_PASSWORD,
    });
    const role = await seedRole(dataSource, {
      siteId,
      name: 'Guest editor',
      permissions: [Permission.ContentEditAny],
    });
    await seedMembership(dataSource, {
      siteId,
      userId: guest.id,
      roleId: role.id,
    });
    expect(await rowsOf(siteId)).toEqual({
      sites: 1,
      hostnames: 2,
      roles: 2,
      site_members: 2,
      content_types: 2,
      content: 2,
    });

    // Asked about first, so the address lookup holds the site when it is deleted.
    await api().get('/sites/resolve?host=deli.test').expect(200);
    await api().get('/public/site?host=deli.test&path=/').expect(200);

    await deleteSite(orchard.admin, siteId).expect(204);

    expect(await rowsOf(siteId)).toEqual({
      sites: 0,
      hostnames: 0,
      roles: 0,
      site_members: 0,
      content_types: 0,
      content: 0,
    });
    for (const host of ['deli.test', 'www.deli.test']) {
      await api().get(`/sites/resolve?host=${host}`).expect(404);
      await api().get(`/public/site?host=${host}&path=/`).expect(404);
    }
    // The people are kept; only their place on the site goes.
    expect(
      await dataSource.query('SELECT 1 FROM users WHERE id = $1', [guest.id]),
    ).toHaveLength(1);

    // Its owner's next sign-in no longer lists it; her other site and the other client are as they were.
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
    ).toEqual(['Orchard Bakery']);
    await api().get('/public/site?host=orchard.test&path=/').expect(200);
    await api().get('/public/site?host=maple.test&path=/').expect(200);

    // The address is free for a new site at once.
    const again = await newSite(orchard.admin, 'Harbour Deli again', [
      'deli.test',
    ]);
    await api()
      .get('/public/site?host=deli.test&path=/')
      .expect(200)
      .expect((res) => expect(res.body.site.name).toBe('Harbour Deli again'));
    await deleteSite(orchard.admin, again).expect(204);
  });

  it('[UC-SD-02] only the owner of the organisation may: a member is refused, anyone else is told there is no such site, and nothing is deleted', async () => {
    const { api, orchard, maple } = world;
    const siteId = await newSite(orchard.admin, 'Orchard Annex', [
      'annex.test',
    ]);
    const before = await rowsOf(siteId);

    // A member of Orchard Bakery who does not own Orchard Holdings, on the owner's own site.
    const orchardBakery = orchard.siteId;
    const refused = await deleteSite(orchard.editor, orchardBakery).expect(403);
    expect(refused.body.message).toBe(
      'Only the owner of the organisation can delete this site',
    );
    // The owner of another organisation: not their site, so not one they can see.
    await deleteSite(maple.admin, siteId).expect(404);
    await deleteSite(maple.admin, orchardBakery).expect(404);
    // No such site, an id that is not one, and no sign-in.
    await deleteSite(
      orchard.admin,
      '0198f2a0-0000-7000-8000-00000000dead',
    ).expect(404);
    await deleteSite(orchard.admin, 'not-a-site').expect(404);
    await api().delete(`/sites/${siteId}`).expect(401);

    expect(await rowsOf(siteId)).toEqual(before);
    expect((await rowsOf(orchardBakery)).sites).toBe(1);
    await api().get('/sites/resolve?host=annex.test').expect(200);
    await deleteSite(orchard.admin, siteId).expect(204);
  });

  it('[UC-SD-04] sign-in says, for each site, whether the person owns its organisation, so the admin offers Delete only there', async () => {
    const { api, orchard, maple } = world;
    const me = async (who: Who) =>
      (await api().get('/auth/me').set(signedIn(who)).expect(200)).body
        .memberships as { site: { name: string }; ownsOrganization: boolean }[];

    expect(
      (await me(orchard.admin)).map((m) => [m.site.name, m.ownsOrganization]),
    ).toEqual([['Orchard Bakery', true]]);
    expect(
      (await me(orchard.editor)).map((m) => [m.site.name, m.ownsOrganization]),
    ).toEqual([['Orchard Bakery', false]]);
    expect(
      (await me(maple.admin)).map((m) => [m.site.name, m.ownsOrganization]),
    ).toEqual([['Maple Books', true]]);
  });
});
