import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  buildContentWorld,
  type ContentWorld,
  type Who,
} from './support/content-world.js';
import {
  TEST_PASSWORD,
  seedPage,
  seedTrashedPage,
  seedUser,
} from './support/seed.js';
import { rowCounts } from './support/tenant.js';

/**
 * Every save keeps its version (version-history T2, `docs/features/version-history/`): making a page
 * and saving it write the page and its version together, through the real routes and the real
 * login, with nothing mocked. The versions are read back through the two read routes of T1. A small
 * stand-in for the public website records what it is told, as in website-cache.e2e-spec.ts, for the
 * cases that say whether the website hears of a save.
 */

// Making the people hashes passwords with production-cost scrypt (about 0.2 s each).
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const SECRET = 'test-revalidate-secret';

let world: ContentWorld;
let website: Server;
/** How many times the website was told to forget a site since the last reset. */
let told = 0;

beforeAll(async () => {
  website = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      told += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
  });
  await new Promise<void>((resolve) => website.listen(0, '127.0.0.1', resolve));
  const { port } = website.address() as AddressInfo;
  process.env.WEB_REVALIDATE_URL = `http://127.0.0.1:${port}/api/revalidate`;
  process.env.REVALIDATE_SECRET = SECRET;

  world = await buildContentWorld();
});

beforeEach(() => {
  told = 0;
});

afterAll(async () => {
  process.env.WEB_REVALIDATE_URL = '';
  delete process.env.REVALIDATE_SECRET;
  await world.close();
  await new Promise<void>((resolve) => website.close(() => resolve()));
});

const api = () => world.api();

type Page = Record<string, any>;

/** The seven things a save accepts, which is exactly what a version holds (plan D6). */
const FIELDS = [
  'title',
  'blocks',
  'data',
  'seoTitle',
  'seoDescription',
  'canonicalUrl',
  'noIndex',
] as const;

/** Only those seven fields of a page or of a version, so the two can be compared. */
const content = (from: Page) =>
  Object.fromEntries(FIELDS.map((field) => [field, from[field]]));

const hero = (headline: string) => ({ type: 'hero', headline });

const save = (who: Who, pageId: string, body: object) =>
  api().patch(`/content/${pageId}`).set(who.headers).send(body);

const readPage = async (who: Who, pageId: string): Promise<Page> =>
  (await api().get(`/content/${pageId}`).set(who.headers).expect(200)).body;

const countVersions = async (who: Who, pageId: string): Promise<number> =>
  (await api().get(`/content/${pageId}/versions`).set(who.headers).expect(200))
    .body.total;

/** Every version of a page, newest first, each read in full. */
async function versionsOf(who: Who, pageId: string): Promise<Page[]> {
  const list = await api()
    .get(`/content/${pageId}/versions?limit=100`)
    .set(who.headers)
    .expect(200);
  const found: Page[] = [];
  for (const item of list.body.items as { id: string }[]) {
    const one = await api()
      .get(`/content/${pageId}/versions/${item.id}`)
      .set(who.headers)
      .expect(200);
    found.push(one.body);
  }
  return found;
}

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
const uniq = () => `w${(serial += 1)}`;

/**
 * A page written straight to the table, as every new website's Home page is and as every page from
 * before this feature is: no save made it, so it has no version. Last changed at `changedAt` by
 * `changedBy`.
 */
async function aPageWithoutAVersion(
  extra: {
    createdBy?: string | null;
    changedBy?: string | null;
    changedAt?: Date;
    fields?: Record<string, unknown>;
  } = {},
) {
  const slug = uniq();
  const page = await seedPage(world.dataSource, {
    siteId: siteId(),
    contentTypeId: await pageTypeId(siteId()),
    title: `Page ${slug}`,
    slug,
    path: `/${slug}`,
    createdBy: extra.createdBy ?? null,
    updatedBy: extra.changedBy ?? extra.createdBy ?? null,
    ...extra.fields,
  });
  if (extra.changedAt) {
    // Past TypeORM, which would stamp "now" on any save of the row.
    await world.dataSource.query(
      'UPDATE content SET updated_at = $1 WHERE id = $2',
      [extra.changedAt, page.id],
    );
  }
  return page;
}

describe('a new page and every save keep their version', () => {
  it('[UC-VH-01] a new page keeps its first version, saved by its maker just now, holding the page as it was made', async () => {
    const { editor } = world.orchard;
    const before = Date.now();

    const page = await world.newPage(editor, 'about', {
      blocks: [hero('Welcome')],
      data: { shelf: 'top' },
      seoDescription: 'Bread, baked daily',
    });

    const list = await api()
      .get(`/content/${page.id}/versions`)
      .set(editor.headers)
      .expect(200);
    expect(list.body.total).toBe(1);
    const [item] = list.body.items;
    expect(item.savedBy).toEqual({ id: editor.userId, name: 'Editor Person' });
    expect(Date.parse(item.savedAt)).toBeGreaterThanOrEqual(before - 1000);
    expect(Date.parse(item.savedAt)).toBeLessThanOrEqual(Date.now() + 1000);

    const one = await api()
      .get(`/content/${page.id}/versions/${item.id}`)
      .set(editor.headers)
      .expect(200);
    expect(one.body).toEqual({
      id: item.id,
      savedAt: item.savedAt,
      savedBy: { id: editor.userId, name: 'Editor Person' },
      title: 'Title about',
      blocks: [hero('Welcome')],
      data: { shelf: 'top' },
      seoTitle: null,
      seoDescription: 'Bread, baked daily',
      canonicalUrl: null,
      noIndex: false,
    });
  });

  it('[UC-VH-02] each save that changes something adds a version, newest first in the order of the saves, the newest being the page as it is now', async () => {
    const { editor, admin } = world.orchard;
    const page = await world.newPage(editor, 'rolling', {
      blocks: [hero('First')],
    });

    await save(editor, page.id, { title: 'Second title' }).expect(200);
    await save(admin, page.id, { blocks: [hero('Third')] }).expect(200);
    await save(editor, page.id, { seoDescription: 'Fourth' }).expect(200);

    const versions = await versionsOf(editor, page.id);
    const same = {
      data: {},
      seoTitle: null,
      canonicalUrl: null,
      noIndex: false,
    };
    expect(versions.map(content)).toEqual([
      {
        ...same,
        title: 'Second title',
        blocks: [hero('Third')],
        seoDescription: 'Fourth',
      },
      {
        ...same,
        title: 'Second title',
        blocks: [hero('Third')],
        seoDescription: null,
      },
      {
        ...same,
        title: 'Second title',
        blocks: [hero('First')],
        seoDescription: null,
      },
      {
        ...same,
        title: 'Title rolling',
        blocks: [hero('First')],
        seoDescription: null,
      },
    ]);
    expect(versions.map((version) => version.savedBy?.name)).toEqual([
      'Editor Person',
      'Olivia Orchard',
      'Editor Person',
      'Editor Person',
    ]);
    // Each is a later moment than the one before.
    const moments = versions.map((version) => Date.parse(version.savedAt));
    for (let n = 1; n < moments.length; n += 1) {
      expect(moments[n - 1]).toBeGreaterThan(moments[n]);
    }
    expect(content(versions[0])).toEqual(
      content(await readPage(editor, page.id)),
    );
  });

  it('[UC-VH-03] a save that changes nothing writes nothing: no version, no new "last changed" or "updated by", and the website is not told', async () => {
    const { admin, editor } = world.orchard;
    const page = await world.newPage(admin, 'steady', {
      blocks: [hero('Same')],
      data: { first: 1, second: 2 },
    });
    await save(admin, page.id, { title: 'Settled' }).expect(200);
    await api()
      .post(`/content/${page.id}/publish`)
      .set(admin.headers)
      .expect(200);
    const before = await readPage(admin, page.id);
    expect(await countVersions(admin, page.id)).toBe(2);
    told = 0; // the publish told the website; count from here

    const res = await save(editor, page.id, {
      title: '  Settled  ', // tidies to the same title
      blocks: [hero('Same')],
      data: { second: 2, first: 1 }, // the same values, written in another order
      noIndex: false,
    }).expect(200);

    expect(res.body).toEqual(before);
    expect(res.body.updatedBy).toBe(admin.userId); // not the editor, who changed nothing
    expect(await readPage(admin, page.id)).toEqual(before);
    expect(await countVersions(admin, page.id)).toBe(2);
    expect(told).toBe(0);
  });

  it('[UC-VH-04] publishing and unpublishing make no version, on a page with versions or without', async () => {
    const { admin, publisher } = world.orchard;
    const page = await world.newPage(admin, 'switch');
    await save(admin, page.id, { title: 'Switch, edited' }).expect(200);
    expect(await countVersions(admin, page.id)).toBe(2);

    const live = await api()
      .post(`/content/${page.id}/publish`)
      .set(publisher.headers)
      .expect(200);
    expect(live.body).toMatchObject({
      status: 'published',
      updatedBy: publisher.userId,
    });
    const back = await api()
      .post(`/content/${page.id}/unpublish`)
      .set(admin.headers)
      .expect(200);
    expect(back.body).toMatchObject({
      status: 'draft',
      updatedBy: admin.userId,
    });
    expect(await countVersions(admin, page.id)).toBe(2);

    // A page nobody has saved stays without versions: publishing is not a save, so it does not
    // keep the version the page had (that waits for the first real save).
    const unsaved = await aPageWithoutAVersion();
    await api()
      .post(`/content/${unsaved.id}/publish`)
      .set(admin.headers)
      .expect(200);
    expect(await countVersions(admin, unsaved.id)).toBe(0);
  });

  it('[UC-VH-05] the first save of a page that has no version keeps the version it had, dated when it was last changed and credited to who changed it', async () => {
    const { editor } = world.orchard;
    const dana = await seedUser(world.dataSource, {
      email: 'dana@orchard.test',
      name: 'Dana Dee',
      password: TEST_PASSWORD,
    });
    const known = new Date('2025-12-01T10:00:00.000Z');
    const old = {
      title: 'Old title',
      blocks: [hero('Old')],
      data: { shelf: 'bottom' },
      seoTitle: 'Old search title',
      seoDescription: 'Old search description',
      canonicalUrl: 'https://orchard.test/old',
      noIndex: true,
    };
    const page = await aPageWithoutAVersion({
      createdBy: dana.id,
      changedBy: dana.id,
      changedAt: known,
      fields: old,
    });
    expect(await countVersions(editor, page.id)).toBe(0);

    await save(editor, page.id, { title: 'New title' }).expect(200);

    const versions = await versionsOf(editor, page.id);
    expect(versions).toHaveLength(2);
    const [newer, older] = versions;
    expect(content(older)).toEqual(old);
    expect(older.savedAt).toBe(known.toISOString());
    expect(older.savedBy).toEqual({ id: dana.id, name: 'Dana Dee' });
    expect(content(newer)).toEqual({ ...old, title: 'New title' });
    expect(newer.savedBy).toEqual({ id: editor.userId, name: 'Editor Person' });
    expect(Math.abs(Date.parse(newer.savedAt) - Date.now())).toBeLessThan(
      10_000,
    );
  });

  it('[UC-VH-07] a version holds exactly the seven things a save accepts, the text block in its cleaned form, and nothing about the address, the parent, the status or any person but their name', async () => {
    const { admin, editor } = world.orchard;
    const parent = await world.newPage(admin, 'section');
    const page = await world.newPage(editor, 'holding', {
      title: 'A page that holds things',
      blocks: [
        hero('Held'),
        {
          type: 'richText',
          html: '<p>Hello <b>bold</b></p><script>alert(1)</script>',
        },
      ],
      data: { shelf: 'top' },
      seoTitle: 'Search title',
      seoDescription: 'Search description',
      canonicalUrl: 'https://orchard.test/original',
      noIndex: true,
    });
    await world.dataSource.query(
      'UPDATE content SET parent_id = $1 WHERE id = $2 AND site_id = $3',
      [parent.id, page.id, siteId()],
    );
    await api()
      .post(`/content/${page.id}/publish`)
      .set(admin.headers)
      .expect(200);
    await save(editor, page.id, { title: 'A page, edited' }).expect(200);

    const versions = await versionsOf(editor, page.id);
    expect(versions).toHaveLength(2);
    const stored = await readPage(editor, page.id);
    for (const version of versions) {
      expect(Object.keys(version).sort()).toEqual([
        'blocks',
        'canonicalUrl',
        'data',
        'id',
        'noIndex',
        'savedAt',
        'savedBy',
        'seoDescription',
        'seoTitle',
        'title',
      ]);
      expect(Object.keys(version.savedBy).sort()).toEqual(['id', 'name']);
      // The text block is the form the page stores: the script is gone, `b` became `strong`.
      expect(version.blocks).toEqual(stored.blocks);
      const text = JSON.stringify(version);
      expect(text).not.toContain('<script');
      expect(text).not.toContain('alert(1)');
      for (const absent of [
        '/holding',
        'published',
        parent.id,
        '@orchard.test',
        'passwordHash',
      ]) {
        expect(text).not.toContain(absent);
      }
    }
    expect(versions[0].blocks[1]).toEqual({
      type: 'richText',
      html: '<p>Hello <strong>bold</strong></p>',
    });

    // And what is stored holds the same seven things and no more.
    const rows = await world.dataSource.query<
      { snapshot: Record<string, unknown> }[]
    >('SELECT snapshot FROM revisions WHERE content_id = $1', [page.id]);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(Object.keys(row.snapshot).sort()).toEqual([...FIELDS].sort());
    }
  });

  it('[UC-VH-08] a create or a save that fails or is refused leaves no version, and no row anywhere', async () => {
    const { admin, viewer } = world.orchard;
    const page = await world.newPage(admin, 'about-us');
    const trashed = await seedTrashedPage(world.dataSource, {
      siteId: siteId(),
      contentTypeId: await pageTypeId(siteId()),
      title: 'In the trash',
      slug: 'in-the-trash',
      path: '/in-the-trash',
    });
    const counts = await rowCounts(world.dataSource);

    // The address is taken.
    await api()
      .post('/content')
      .set(admin.headers)
      .send({ type: 'page', title: 'Another', slug: 'about-us' })
      .expect(409);
    // A type the site does not have.
    await api()
      .post('/content')
      .set(admin.headers)
      .send({ type: 'nothing', title: 'Another', slug: 'another' })
      .expect(400);
    await save(admin, page.id, { title: '' }).expect(400);
    await save(admin, page.id, { slug: 'moved' }).expect(400);
    await save(viewer, page.id, { title: 'Not allowed' }).expect(403);
    await save(admin, randomUUID(), { title: 'Gone' }).expect(404);
    await save(admin, trashed.id, { title: 'Trashed' }).expect(404);

    expect(await rowCounts(world.dataSource)).toEqual(counts);
  });

  it('[UC-VH-09] if the version cannot be written, the save does not happen, and a page cannot be made either; with the fault gone the save works', async () => {
    const { editor } = world.orchard;
    const page = await world.newPage(editor, 'fragile');
    const before = await readPage(editor, page.id);
    const counts = await rowCounts(world.dataSource);

    await world.dataSource.query(
      `CREATE OR REPLACE FUNCTION refuse_new_version() RETURNS trigger LANGUAGE plpgsql
         AS $$ BEGIN RAISE EXCEPTION 'a version is refused in this test'; END $$`,
    );
    await world.dataSource.query(
      `CREATE TRIGGER refuse_new_version BEFORE INSERT ON revisions
         FOR EACH ROW EXECUTE FUNCTION refuse_new_version()`,
    );
    // The two server errors below are the point of the test: do not print them as if they were trouble.
    const quiet = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    try {
      await save(editor, page.id, { title: 'Never saved' }).expect(500);
      await api()
        .post('/content')
        .set(editor.headers)
        .send({ type: 'page', title: 'Never made', slug: 'never-made' })
        .expect(500);

      expect(await readPage(editor, page.id)).toEqual(before); // title and "last changed"
      expect(await rowCounts(world.dataSource)).toEqual(counts); // no version, no page
    } finally {
      quiet.mockRestore();
      await world.dataSource.query(
        'DROP TRIGGER IF EXISTS refuse_new_version ON revisions',
      );
      await world.dataSource.query(
        'DROP FUNCTION IF EXISTS refuse_new_version()',
      );
    }

    await save(editor, page.id, { title: 'Saved now' }).expect(200);
    expect(await countVersions(editor, page.id)).toBe(2);
  });

  it('[UC-VH-10] two saves at once are both kept: both succeed, the page holds both changes, there are three versions, and the newest is the page', async () => {
    const { editor, admin } = world.orchard;
    const page = await world.newPage(editor, 'crowded');

    const [one, two] = await Promise.all([
      save(editor, page.id, { title: 'Title from one' }),
      save(admin, page.id, { blocks: [hero('Blocks from two')] }),
    ]);

    expect([one.status, two.status]).toEqual([200, 200]);
    const now = await readPage(editor, page.id);
    expect(now).toMatchObject({
      title: 'Title from one',
      blocks: [hero('Blocks from two')],
    });
    const versions = await versionsOf(editor, page.id);
    expect(versions).toHaveLength(3);
    expect(content(versions[0])).toEqual(content(now));
  });

  it('[UC-VH-10] six saves at once to a page with no version keep one first version and each save in turn: none lost, none merged, none written twice', async () => {
    const { editor, admin } = world.orchard;
    const page = await aPageWithoutAVersion({ createdBy: admin.userId });
    const changes = [
      { title: 'Title, new' },
      { blocks: [hero('Blocks, new')] },
      { data: { added: true } },
      { seoTitle: 'Search title, new' },
      { seoDescription: 'Search description, new' },
      { noIndex: true },
    ];

    const answers = await Promise.all(
      changes.map((change, n) =>
        save(n % 2 === 0 ? editor : admin, page.id, change),
      ),
    );

    expect(answers.map((answer) => answer.status)).toEqual(
      changes.map(() => 200),
    );
    const now = await readPage(admin, page.id);
    expect(now).toMatchObject(Object.assign({}, ...changes));
    const versions = await versionsOf(admin, page.id);
    // The version the page had, and the six saves.
    expect(versions).toHaveLength(7);
    expect(content(versions[0])).toEqual(content(now));
    // Oldest first, each version differs from the one before in exactly one thing: the saves
    // queued up, so each started from what the one before it left.
    const oldestFirst = versions.reverse().map(content);
    for (let n = 1; n < oldestFirst.length; n += 1) {
      const changed = FIELDS.filter(
        (field) =>
          JSON.stringify(oldestFirst[n][field]) !==
          JSON.stringify(oldestFirst[n - 1][field]),
      );
      expect(changed).toHaveLength(1);
    }
  });

  it('[UC-VH-13] old versions never change, and the version routes only read', async () => {
    const { admin, editor } = world.orchard;
    const page = await world.newPage(editor, 'frozen', {
      blocks: [hero('One')],
    });
    await save(editor, page.id, { title: 'Two' }).expect(200);
    await save(admin, page.id, { blocks: [hero('Three')] }).expect(200);
    const before = await versionsOf(editor, page.id); // each read once
    expect(before).toHaveLength(3);

    // Saved again, and saved with the oldest version's content (what Restore then Save does).
    await save(editor, page.id, { title: 'Four' }).expect(200);
    const oldest = before[2];
    await save(editor, page.id, {
      title: oldest.title,
      blocks: oldest.blocks,
      data: oldest.data,
      seoTitle: oldest.seoTitle,
      seoDescription: oldest.seoDescription,
      canonicalUrl: oldest.canonicalUrl,
      noIndex: oldest.noIndex,
    }).expect(200);

    for (const route of [
      `/content/${page.id}/versions`,
      `/content/${page.id}/versions/${before[0].id}`,
    ]) {
      for (const method of ['patch', 'put', 'delete', 'post'] as const) {
        await api()
          [method](route)
          .set(editor.headers)
          .send({ title: 'Meddling' })
          .expect(404);
      }
    }

    const after = await versionsOf(editor, page.id);
    expect(after).toHaveLength(5);
    expect(after.slice(2)).toEqual(before); // the three that were there, as they were
    expect(content(after[0])).toEqual(content(await readPage(editor, page.id)));
  });

  it('[UC-VH-22] saving a published page still tells the website once; a save that changes nothing does not; publish and unpublish tell it as before', async () => {
    const { admin } = world.orchard;
    const live = await world.newPage(admin, 'told-live');
    await api()
      .post(`/content/${live.id}/publish`)
      .set(admin.headers)
      .expect(200);
    expect(told).toBe(1);
    told = 0;

    await save(admin, live.id, { title: 'A real change' }).expect(200);
    expect(told).toBe(1);
    await save(admin, live.id, { title: 'A real change' }).expect(200);
    expect(told).toBe(1);

    const other = await world.newPage(admin, 'told-other');
    expect(told).toBe(1); // a draft is not public
    await api()
      .post(`/content/${other.id}/publish`)
      .set(admin.headers)
      .expect(200);
    expect(told).toBe(2);
    await api()
      .post(`/content/${other.id}/unpublish`)
      .set(admin.headers)
      .expect(200);
    expect(told).toBe(3);
  });

  it('[UC-VH-23] a new website’s Home page has no version until its first save, then two', async () => {
    const { admin } = world.orchard;
    const made = await api()
      .post('/sites')
      .set({ Authorization: admin.headers.Authorization })
      .send({ name: 'Versions Cafe', hostnames: ['versions-cafe.test'] })
      .expect(201);
    const owner = {
      userId: admin.userId,
      headers: {
        Authorization: admin.headers.Authorization,
        'X-Site-Id': made.body.site.id as string,
      },
    };

    const found = await api()
      .get('/content?path=/home')
      .set(owner.headers)
      .expect(200);
    const [home] = found.body.items as {
      id: string;
      title: string;
      updatedBy: string | null;
    }[];
    expect(home.title).toBe('Home');
    expect(await countVersions(owner, home.id)).toBe(0);

    await save(owner, home.id, { title: 'Welcome' }).expect(200);

    const versions = await versionsOf(owner, home.id);
    expect(versions).toHaveLength(2);
    expect(versions[0].title).toBe('Welcome');
    expect(versions[1].title).toBe('Home');
    // The one it had is credited to whoever last changed it (the person who made the site).
    expect(versions[1].savedBy?.id ?? null).toBe(home.updatedBy);
  });
});
