import { randomUUID } from 'node:crypto';
import {
  buildContentWorld,
  type ContentWorld,
} from './support/content-world.js';
import { addMember } from './support/members.js';
import {
  TEST_PASSWORD,
  seedPage,
  seedTrashedPage,
  seedUser,
  seedVersion,
} from './support/seed.js';
import { rowCounts } from './support/tenant.js';
import { signTestToken } from './support/tokens.js';

/**
 * Reading a page's versions (version-history T1, `docs/features/version-history/`): the two routes
 * `GET /content/:id/versions` and `GET /content/:id/versions/:versionId`, through the real routes and
 * the real login, with nothing mocked. The versions are written straight to the table by a helper,
 * because writing them on a save is T2; the tests of T2 read them back through these routes.
 */

// Making the people hashes passwords with production-cost scrypt (about 0.2 s each).
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let world: ContentWorld;
const api = () => world.api();

beforeAll(async () => {
  world = await buildContentWorld();
});

afterAll(async () => {
  await world.close();
});

type Person = Pick<ContentWorld['orchard']['admin'], 'userId' | 'headers'>;

const siteId = () => world.orchard.siteId;

/** The site's "page" content type, which provisioning made. */
async function pageTypeId(site: string): Promise<string> {
  const [row] = await world.dataSource.query<{ id: string }[]>(
    `SELECT id FROM content_types WHERE site_id = $1 AND slug = 'page'`,
    [site],
  );
  return row.id;
}

let serial = 0;
const uniq = () => `v${(serial += 1)}`;

/** A page written straight to the table, on Orchard's site unless told otherwise, with no version. */
async function aPage(
  createdBy: string | null = null,
  extra: { siteId?: string; title?: string } = {},
) {
  const slug = uniq();
  const site = extra.siteId ?? siteId();
  return seedPage(world.dataSource, {
    siteId: site,
    contentTypeId: await pageTypeId(site),
    title: extra.title ?? `Page ${slug}`,
    slug,
    path: `/${slug}`,
    createdBy,
    updatedBy: createdBy,
  });
}

/** A version of `page` at a known time, by `by` (or no one). */
const aVersion = (
  page: { id: string; siteId: string },
  by: string | null,
  at: Date,
  snapshot?: Record<string, unknown>,
) =>
  seedVersion(world.dataSource, {
    siteId: page.siteId,
    contentId: page.id,
    createdBy: by,
    createdAt: at,
    ...(snapshot ? { snapshot } : {}),
  });

const versionsOf = (who: Person, pageId: string, query = '') =>
  api().get(`/content/${pageId}/versions${query}`).set(who.headers);

const versionOf = (who: Person, pageId: string, versionId: string) =>
  api().get(`/content/${pageId}/versions/${versionId}`).set(who.headers);

const MINUTE = 60_000;
const T0 = Date.parse('2030-01-01T09:00:00.000Z');

describe('reading a page’s versions', () => {
  it('[UC-VH-06] a page nobody has saved has an empty history, not an error', async () => {
    const page = await aPage();

    const res = await versionsOf(world.orchard.editor, page.id).expect(200);

    expect(res.body).toEqual({ items: [], total: 0, limit: 20, offset: 0 });
  });

  it('[UC-VH-11] the list is newest first, in slices, with a total, and checks its paging', async () => {
    const page = await aPage();
    const { editor, admin } = world.orchard;
    const ids: string[] = [];
    for (let n = 0; n < 45; n += 1) {
      const version = await aVersion(
        page,
        admin.userId,
        new Date(T0 + n * MINUTE),
      );
      ids.push(version.id);
    }
    const newestFirst = [...ids].reverse();
    const slice = async (query: string) =>
      (await versionsOf(editor, page.id, query).expect(200)).body as {
        items: { id: string; savedAt: string }[];
        total: number;
        limit: number;
        offset: number;
      };

    // The first slice: the 20 newest, with the total.
    const first = await slice('');
    expect(first).toMatchObject({ total: 45, limit: 20, offset: 0 });
    expect(first.items.map((item) => item.id)).toEqual(
      newestFirst.slice(0, 20),
    );
    expect(first.items[0]).toEqual({
      id: newestFirst[0],
      savedAt: new Date(T0 + 44 * MINUTE).toISOString(),
      savedBy: { id: admin.userId, name: 'Olivia Orchard' },
    });

    // The next slices, and past the end: an empty list that still says 45.
    expect((await slice('?offset=20')).items.map((item) => item.id)).toEqual(
      newestFirst.slice(20, 40),
    );
    expect((await slice('?offset=40')).items.map((item) => item.id)).toEqual(
      newestFirst.slice(40),
    );
    expect(await slice('?offset=60')).toMatchObject({
      items: [],
      total: 45,
      offset: 60,
    });
    expect((await slice('?limit=100')).items).toHaveLength(45);

    // Paging that makes no sense is a 400 that names the field, as the other lists do.
    for (const [query, field] of [
      ['?limit=101', 'limit'],
      ['?limit=0', 'limit'],
      ['?offset=-1', 'offset'],
      ['?limit=abc', 'limit'],
    ] as const) {
      const res = await versionsOf(editor, page.id, query).expect(400);
      expect(
        res.body.errors.some((line: string) => line.startsWith(`${field}: `)),
        query,
      ).toBe(true);
    }
  });

  it('[UC-VH-12] one version can be read in full, in the shape Save accepts', async () => {
    const { editor, admin } = world.orchard;
    const page = await aPage();
    const at = new Date(T0);
    const version = await aVersion(page, admin.userId, at, {
      title: 'Opening hours',
      blocks: [
        { type: 'hero', headline: 'We are open' },
        { type: 'text', props: { body: '<p>Daily</p>' } },
      ],
      data: { floor: 2 },
      seoTitle: 'Opening hours — Orchard',
      seoDescription: 'When we are open',
      canonicalUrl: 'https://orchard.test/opening-hours',
      noIndex: true,
    });

    const res = await versionOf(editor, page.id, version.id).expect(200);
    expect(res.body).toEqual({
      id: version.id,
      savedAt: at.toISOString(),
      savedBy: { id: admin.userId, name: 'Olivia Orchard' },
      title: 'Opening hours',
      blocks: [
        { type: 'hero', headline: 'We are open' },
        { type: 'text', props: { body: '<p>Daily</p>' } },
      ],
      data: { floor: 2 },
      seoTitle: 'Opening hours — Orchard',
      seoDescription: 'When we are open',
      canonicalUrl: 'https://orchard.test/opening-hours',
      noIndex: true,
    });

    // A snapshot that lacks a field (an older shape) still answers all seven, with their empty values.
    const sparse = await aVersion(page, null, new Date(T0 + MINUTE), {
      title: 'Old',
    });
    const old = await versionOf(editor, page.id, sparse.id).expect(200);
    expect(old.body).toEqual({
      id: sparse.id,
      savedAt: new Date(T0 + MINUTE).toISOString(),
      savedBy: null,
      title: 'Old',
      blocks: [],
      data: {},
      seoTitle: null,
      seoDescription: null,
      canonicalUrl: null,
      noIndex: false,
    });
  });

  it('[UC-VH-14] a version names who saved it, by name only, and a removed account shows no one', async () => {
    const { editor } = world.orchard;
    const maya = await seedUser(world.dataSource, {
      email: 'maya@orchard.test',
      name: 'Maya Moss',
      password: TEST_PASSWORD,
    });
    const gone = await seedUser(world.dataSource, {
      email: 'gone@orchard.test',
      name: 'Gone Person',
      password: TEST_PASSWORD,
    });
    const page = await aPage();
    const byMaya = await aVersion(page, maya.id, new Date(T0 + MINUTE));
    const byGone = await aVersion(page, gone.id, new Date(T0));
    // The account is removed; the version stays, and no longer says who.
    await world.dataSource.query('DELETE FROM users WHERE id = $1', [gone.id]);

    const list = await versionsOf(editor, page.id).expect(200);
    expect(list.body.items).toEqual([
      {
        id: byMaya.id,
        savedAt: new Date(T0 + MINUTE).toISOString(),
        savedBy: { id: maya.id, name: 'Maya Moss' },
      },
      { id: byGone.id, savedAt: new Date(T0).toISOString(), savedBy: null },
    ]);
    const one = await versionOf(editor, page.id, byGone.id).expect(200);
    expect(one.body.savedBy).toBeNull();

    // Never an email, never a password hash, in either answer.
    const text = JSON.stringify([list.body, one.body]);
    expect(text).not.toContain('maya@orchard.test');
    expect(text).not.toContain(maya.passwordHash);
    expect(text).not.toMatch(/password/i);
  });

  it('[UC-VH-15] a version of one page cannot be read through another page, and every miss answers alike', async () => {
    const { editor } = world.orchard;
    const a = await aPage();
    const b = await aPage();
    const versionA = await aVersion(a, null, new Date(T0));
    await aVersion(b, null, new Date(T0));

    // The version under its own page is there (so the refusals below are about whose it is).
    await versionOf(editor, a.id, versionA.id).expect(200);

    const misses = [
      await versionOf(editor, b.id, versionA.id), // A's version under B
      await versionOf(editor, a.id, randomUUID()), // an id nobody has
      await versionOf(editor, a.id, 'not-a-uuid'), // not an id at all
      await versionOf(editor, randomUUID(), versionA.id), // a page that is not there
    ];
    for (const res of misses) {
      expect(res.status).toBe(404);
      expect(res.body.message).toBe('Version not found');
    }
  });

  it('[UC-VH-16] whoever may edit a page may read its versions; nobody else', async () => {
    const site = siteId();
    const person = (
      role: 'Administrator' | 'Editor' | 'Author' | 'Contributor' | 'Viewer',
      email: string,
    ) => addMember(world.app, site, { email, name: `${role} Test`, role });
    const administrator = await person('Administrator', 'admin2@orchard.test');
    const editor = await person('Editor', 'editor2@orchard.test');
    const author = await person('Author', 'author2@orchard.test');
    const otherAuthor = await person('Author', 'author3@orchard.test');
    const contributor = await person('Contributor', 'contrib@orchard.test');
    const viewer = await person('Viewer', 'viewer2@orchard.test');
    const owner = world.orchard.admin; // Olivia, who owns the organization
    const publisher = world.orchard.publisher; // may publish, may not edit

    const authorsPage = await aPage(author.userId);
    const contributorsPage = await aPage(contributor.userId);
    const [authorsVersion, contributorsVersion] = await Promise.all([
      aVersion(authorsPage, author.userId, new Date(T0)),
      aVersion(contributorsPage, contributor.userId, new Date(T0)),
    ]);
    const versionIdOf = (page: { id: string }) =>
      page.id === authorsPage.id ? authorsVersion.id : contributorsVersion.id;

    // Allowed: the list and one version.
    const allowed: [string, Person, { id: string }][] = [
      ['the owner', owner, authorsPage],
      ['an Administrator', administrator, authorsPage],
      ['an Editor', editor, authorsPage],
      ['the Author, on their own page', author, authorsPage],
      ['the Contributor, on their own page', contributor, contributorsPage],
    ];
    for (const [who, person, page] of allowed) {
      expect((await versionsOf(person, page.id)).status, who).toBe(200);
      expect(
        (await versionOf(person, page.id, versionIdOf(page))).status,
        who,
      ).toBe(200);
    }

    // Refused with what Save refuses with: 403.
    const refused: [string, Person, { id: string }][] = [
      ['another Author, on that page', otherAuthor, authorsPage],
      ['a Contributor, on an Author’s page', contributor, authorsPage],
      ['an Author, on a Contributor’s page', author, contributorsPage],
      ['a Viewer', viewer, authorsPage],
      ['a Viewer, on the other page', viewer, contributorsPage],
      ['someone who may only publish', publisher, authorsPage],
    ];
    for (const [who, person, page] of refused) {
      const saving = await api()
        .patch(`/content/${page.id}`)
        .set(person.headers)
        .send({ title: 'Nope' });
      expect(saving.status, `${who}: saving`).toBe(403);
      const list = await versionsOf(person, page.id);
      expect(list.status, who).toBe(403);
      expect(list.body, who).toEqual(saving.body);
      const one = await versionOf(person, page.id, versionIdOf(page));
      expect(one.status, who).toBe(403);
      expect(one.body, who).toEqual(saving.body);
    }
  });

  it('[UC-VH-17] without a sign-in or a website, nothing is answered', async () => {
    const { admin } = world.orchard;
    const page = await aPage();
    const version = await aVersion(page, null, new Date(T0));
    const before = await rowCounts(world.dataSource);
    const closed = await api().get('/content').expect(401);
    const now = Math.floor(Date.now() / 1000);
    const expired = {
      Authorization: `Bearer ${await signTestToken({ sub: admin.userId, iat: now - 7200, exp: now - 3600 })}`,
      'X-Site-Id': siteId(),
    };

    for (const path of [
      `/content/${page.id}/versions`,
      `/content/${page.id}/versions/${version.id}`,
    ]) {
      // No token, and a token that ran out: the body every closed route gives.
      const none = await api().get(path).set('X-Site-Id', siteId()).expect(401);
      expect(none.body).toEqual(closed.body);
      const old = await api().get(path).set(expired).expect(401);
      expect(old.body).toEqual(closed.body);
      // A good token and no website: 400, like every website route.
      await api()
        .get(path)
        .set({ Authorization: admin.headers.Authorization })
        .expect(400);
    }
    expect(await rowCounts(world.dataSource)).toEqual(before);
  });

  it('[UC-VH-18] another website’s versions are never reachable, by page or by version id', async () => {
    const { admin } = world.orchard;
    const mapleAdmin = world.maple.admin;
    const mine = await aPage(null, { title: 'Orchard page' });
    const mineVersion = await aVersion(mine, null, new Date(T0));
    const theirs = await aPage(null, {
      siteId: world.maple.siteId,
      title: 'Maple secret',
    });
    const theirVersion = await aVersion(theirs, null, new Date(T0), {
      title: 'Maple secret',
      blocks: [{ type: 'hero', headline: 'maple only' }],
    });

    // Controls: each person reads their own.
    await versionOf(admin, mine.id, mineVersion.id).expect(200);
    await versionOf(mapleAdmin, theirs.id, theirVersion.id).expect(200);

    // Orchard's owner reaches for Maple's page and version under Orchard's own header: answered as ids that are not there.
    const missing = await versionOf(admin, mine.id, randomUUID());
    const absentPage = await versionsOf(admin, randomUUID());
    const reaches = [
      await versionOf(admin, theirs.id, theirVersion.id), // Maple's page and version
      await versionOf(admin, mine.id, theirVersion.id), // own page, Maple's version
    ];
    for (const res of reaches) {
      expect(res.status).toBe(404);
      expect(res.body).toEqual(missing.body);
    }
    const theirList = await versionsOf(admin, theirs.id);
    expect(theirList.status).toBe(404);
    expect(theirList.body).toEqual(absentPage.body);

    // Orchard's owner with Maple's header: refused as a website that is not theirs, whatever the id.
    const withTheirHeader = await api()
      .get(`/content/${theirs.id}/versions`)
      .set({ ...admin.headers, 'X-Site-Id': world.maple.siteId });
    expect(withTheirHeader.status).toBe(403);

    // Nothing of Maple in any of it.
    const text = JSON.stringify([
      reaches.map((r) => r.body),
      theirList.body,
      withTheirHeader.body,
    ]);
    expect(text).not.toMatch(/maple/i);
  });

  it('[UC-VH-20] a trashed page’s history is hidden, and a website’s deletion removes its versions', async () => {
    const { editor, admin } = world.orchard;

    // In the trash: the same 404 as the page itself (the control is a page that is not trashed).
    const live = await aPage();
    await aVersion(live, null, new Date(T0));
    const trashed = await seedTrashedPage(world.dataSource, {
      siteId: siteId(),
      contentTypeId: await pageTypeId(siteId()),
      title: 'Trashed',
      slug: uniq(),
      path: `/${uniq()}`,
    });
    const trashedVersion = await aVersion(trashed, null, new Date(T0));
    await versionsOf(editor, live.id).expect(200);
    expect((await versionsOf(editor, trashed.id)).status).toBe(404);
    expect(
      (await versionOf(editor, trashed.id, trashedVersion.id)).status,
    ).toBe(404);

    // A website made and then deleted by its owner takes its versions with it; Orchard's stay.
    const made = await api()
      .post('/sites')
      .set({ Authorization: admin.headers.Authorization })
      .send({ name: 'Short Lived', hostnames: ['short-lived.test'] })
      .expect(201);
    const doomed: string = made.body.site.id;
    const doomedPage = await aPage(null, { siteId: doomed });
    await aVersion(doomedPage, null, new Date(T0));
    const count = async (site: string) =>
      (
        await world.dataSource.query<{ n: number }[]>(
          'SELECT count(*)::int AS n FROM revisions WHERE site_id = $1',
          [site],
        )
      )[0].n;
    const orchardBefore = await count(siteId());
    expect(await count(doomed)).toBe(1);

    await api()
      .delete(`/sites/${doomed}`)
      .set({ Authorization: admin.headers.Authorization })
      .expect(204);

    expect(await count(doomed)).toBe(0);
    expect(await count(siteId())).toBe(orchardBefore);
  });
});
