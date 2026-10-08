import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { Permission } from '../src/auth/permission.js';
import { ProvisioningService } from '../src/provisioning/provisioning.service.js';
import { createTestApp } from './support/app.js';
import { resetDatabase } from './support/database.js';
import {
  TEST_PASSWORD,
  seedMembership,
  seedRole,
  seedUser,
} from './support/seed.js';

/**
 * The content API (CNT-01) through the real routes: two clients made by the real provisioning
 * service, people who sign in with the real login, and `Authorization` plus `X-Site-Id` on every
 * call. Nothing is mocked. Names, addresses and passwords below are this file's own.
 */

// Making a client and signing in hash with production-cost scrypt (about 0.2 s each).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

type Who = {
  userId: string;
  headers: { Authorization: string; 'X-Site-Id': string };
};

const UNKNOWN_ID = '0198f2a0-0000-7000-8000-000000000999';

let app: INestApplication;
let dataSource: DataSource;
let orchard: {
  siteId: string;
  admin: Who;
  author: Who;
  editor: Who;
  viewer: Who;
};
let maple: { siteId: string; admin: Who };

const api = () => request(app.getHttpServer());

async function signIn(
  email: string,
  password: string,
  siteId: string,
): Promise<Who> {
  const res = await api()
    .post('/auth/login')
    .send({ email, password })
    .expect(200);
  return {
    userId: res.body.user.id,
    headers: {
      Authorization: `Bearer ${res.body.accessToken}`,
      'X-Site-Id': siteId,
    },
  };
}

/** A person who really signs in, on a role with exactly these permissions. */
async function addMember(
  siteId: string,
  email: string,
  roleName: string,
  permissions: Permission[],
): Promise<Who> {
  const user = await seedUser(dataSource, {
    email,
    name: `${roleName} Person`,
    password: TEST_PASSWORD,
  });
  const role = await seedRole(dataSource, {
    siteId,
    name: roleName,
    permissions,
  });
  await seedMembership(dataSource, {
    siteId,
    userId: user.id,
    roleId: role.id,
  });
  return signIn(email, TEST_PASSWORD, siteId);
}

beforeAll(async () => {
  ({ app, dataSource } = await createTestApp());
  // Listening on a loopback port keeps supertest from opening and closing a listener of its own per call.
  await app.listen(0, '127.0.0.1');
  await resetDatabase(dataSource);

  const provisioning = app.get(ProvisioningService);
  const orchardTenant = await provisioning.provisionTenant({
    organizationName: 'Orchard Holdings',
    siteName: 'Orchard Bakery',
    hostnames: ['orchard.test'],
    admin: {
      email: 'olivia@orchard.test',
      name: 'Olivia Orchard',
      password: 'orchard-admin-password',
    },
  });
  const mapleTenant = await provisioning.provisionTenant({
    organizationName: 'Maple Group',
    siteName: 'Maple Books',
    hostnames: ['maple.test'],
    admin: {
      email: 'mark@maple.test',
      name: 'Mark Maple',
      password: 'maple-admin-password',
    },
  });

  const orchardId = orchardTenant.site.id;
  orchard = {
    siteId: orchardId,
    admin: await signIn(
      'olivia@orchard.test',
      'orchard-admin-password',
      orchardId,
    ),
    author: await addMember(orchardId, 'ada@orchard.test', 'Author', [
      Permission.ContentCreate,
      Permission.ContentEditOwn,
    ]),
    editor: await addMember(orchardId, 'eli@orchard.test', 'Editor', [
      Permission.ContentCreate,
      Permission.ContentEditAny,
    ]),
    viewer: await addMember(orchardId, 'vic@orchard.test', 'Viewer', []),
  };
  maple = {
    siteId: mapleTenant.site.id,
    admin: await signIn(
      'mark@maple.test',
      'maple-admin-password',
      mapleTenant.site.id,
    ),
  };
});

beforeEach(async () => {
  await dataSource.query('DELETE FROM content');
});

afterAll(async () => {
  await app.close();
});

const createPage = (who: Who, body: unknown) =>
  api()
    .post('/content')
    .set(who.headers)
    .send(body as object);

async function newPage(who: Who, slug: string, extra: object = {}) {
  const res = await createPage(who, {
    type: 'page',
    title: `Title ${slug}`,
    slug,
    ...extra,
  }).expect(201);
  return res.body;
}

const edit = (who: Who, id: string, body: object) =>
  api().patch(`/content/${id}`).set(who.headers).send(body);

const countPages = async (): Promise<number> =>
  (await dataSource.query('SELECT count(*)::int AS n FROM content'))[0].n;

const storedRow = async (id: string) =>
  (
    await dataSource.query(
      `SELECT title, slug, path, status, parent_id, site_id, blocks, data, created_by, updated_by, updated_at
         FROM content WHERE id = $1`,
      [id],
    )
  )[0];

describe('content API', () => {
  it('[UC-CA-01] creates a draft page on the signed-in site, with its address, creator and type', async () => {
    const res = await createPage(orchard.admin, {
      type: 'page',
      title: '  About us  ',
      slug: 'about',
    }).expect(201);

    expect(res.body).toMatchObject({
      title: 'About us',
      slug: 'about',
      path: '/about',
      status: 'draft',
      blocks: [],
      data: {},
      parentId: null,
      publishedAt: null,
      createdBy: orchard.admin.userId,
      updatedBy: orchard.admin.userId,
      type: { slug: 'page', name: 'Page' },
    });
    expect(res.body).not.toHaveProperty('siteId');
    expect(await storedRow(res.body.id)).toMatchObject({
      site_id: orchard.siteId,
      path: '/about',
    });

    const withContent = await createPage(orchard.admin, {
      type: 'page',
      title: 'Home',
      slug: 'home',
      blocks: [{ type: 'hero', props: { heading: 'Welcome' } }],
      data: { colour: 'green' },
    }).expect(201);
    expect(withContent.body.blocks).toEqual([
      { type: 'hero', props: { heading: 'Welcome' } },
    ]);
    expect(withContent.body.data).toEqual({ colour: 'green' });
  });

  it("[UC-CA-02] a post's address carries its type's prefix", async () => {
    const res = await createPage(orchard.admin, {
      type: 'post',
      title: 'Hello world',
      slug: 'hello-world',
    }).expect(201);
    expect(res.body.path).toBe('/blog/hello-world');
    expect(res.body.type).toMatchObject({ slug: 'post', name: 'Post' });
  });

  it('[UC-CA-03] lists pages last changed first, with paging and filters, and without blocks', async () => {
    const [a, , c] = [
      await newPage(orchard.admin, 'a', { blocks: [{ type: 'text' }] }),
      await newPage(orchard.admin, 'b'),
      await newPage(orchard.admin, 'c'),
    ];
    for (const slug of ['p', 'q']) {
      await createPage(orchard.admin, {
        type: 'post',
        title: slug,
        slug,
      }).expect(201);
    }
    await dataSource.query(
      `UPDATE content SET status = 'published' WHERE id = $1`,
      [c.id],
    );
    // "a" was the oldest; editing it makes it the newest.
    await edit(orchard.admin, a.id, { title: 'A edited' }).expect(200);

    const list = (query = '') =>
      api().get(`/content${query}`).set(orchard.admin.headers).expect(200);
    const slugs = (res: { body: { items: { slug: string }[] } }) =>
      res.body.items.map((item) => item.slug);

    const all = await list();
    expect(slugs(all)).toEqual(['a', 'q', 'p', 'c', 'b']);
    expect(all.body).toMatchObject({ total: 5, limit: 25, offset: 0 });
    for (const item of all.body.items) {
      expect(item).not.toHaveProperty('blocks');
      expect(item).not.toHaveProperty('data');
      expect(item).not.toHaveProperty('siteId');
    }
    expect(all.body.items[0]).toMatchObject({
      title: 'A edited',
      type: { slug: 'page', name: 'Page' },
    });

    const second = await list('?limit=2&offset=2');
    expect(slugs(second)).toEqual(['p', 'c']);
    expect(second.body).toMatchObject({ total: 5, limit: 2, offset: 2 });

    expect(slugs(await list('?type=post'))).toEqual(['q', 'p']);
    expect((await list('?type=post')).body.total).toBe(2);
    expect(slugs(await list('?status=published'))).toEqual(['c']);
    expect(slugs(await list('?type=post&status=published'))).toEqual([]);
    expect((await list('?type=no-such-type')).body).toMatchObject({
      items: [],
      total: 0,
    });
  });

  it('[UC-CA-04] reads one page with its blocks and data; an unknown or malformed id is a 404', async () => {
    const page = await newPage(orchard.admin, 'about', {
      blocks: [{ type: 'text', props: { body: 'Hello' } }],
      data: { k: 1 },
    });

    const res = await api()
      .get(`/content/${page.id}`)
      .set(orchard.viewer.headers)
      .expect(200);
    expect(res.body).toMatchObject({
      id: page.id,
      path: '/about',
      blocks: [{ type: 'text', props: { body: 'Hello' } }],
      data: { k: 1 },
    });

    for (const id of [UNKNOWN_ID, 'not-a-uuid']) {
      await api().get(`/content/${id}`).set(orchard.admin.headers).expect(404);
    }
  });

  it('[UC-CA-05] edits title, blocks and data, and refuses a body that names anything else', async () => {
    const page = await newPage(orchard.admin, 'about');

    const res = await edit(orchard.editor, page.id, {
      title: ' About ',
      blocks: [{ type: 'text', props: { body: 'New' } }],
      data: { k: 2 },
    }).expect(200);
    expect(res.body).toMatchObject({
      title: 'About',
      blocks: [{ type: 'text', props: { body: 'New' } }],
      data: { k: 2 },
      slug: 'about',
      path: '/about',
      status: 'draft',
      createdBy: orchard.admin.userId,
      updatedBy: orchard.editor.userId,
    });
    expect(new Date(res.body.updatedAt).getTime()).toBeGreaterThan(
      new Date(page.updatedAt).getTime(),
    );

    const before = await storedRow(page.id);
    const refused: Record<string, unknown>[] = [
      { slug: 'changed' },
      { path: '/changed' },
      { status: 'published' },
      { parentId: UNKNOWN_ID },
      { siteId: maple.siteId },
      { id: UNKNOWN_ID },
      { createdBy: UNKNOWN_ID },
      {},
      { title: '' },
      { blocks: 'none' },
    ];
    for (const body of refused) {
      const refusal = await edit(orchard.admin, page.id, body);
      expect(refusal.status, JSON.stringify(body)).toBe(400);
      expect(refusal.body.errors.length).toBeGreaterThan(0);
    }
    expect(await storedRow(page.id)).toEqual(before);
  });

  it("[UC-CA-06] lists the site's content types and nothing of another site's", async () => {
    const res = await api()
      .get('/content-types')
      .set(orchard.viewer.headers)
      .expect(200);
    const bySlug = Object.fromEntries(
      res.body.items.map((type: { slug: string }) => [type.slug, type]),
    );
    expect(Object.keys(bySlug).sort()).toEqual(['page', 'post']);
    expect(bySlug.page).toMatchObject({
      name: 'Page',
      urlPrefix: null,
      hierarchical: true,
      hasCategories: false,
      hasTags: false,
      isBuiltin: true,
    });
    expect(bySlug.post).toMatchObject({
      name: 'Post',
      urlPrefix: '/blog',
      hierarchical: false,
      hasCategories: true,
      hasTags: true,
      isBuiltin: true,
    });

    const others = await api()
      .get('/content-types')
      .set(maple.admin.headers)
      .expect(200);
    const ours = new Set(res.body.items.map((type: { id: string }) => type.id));
    for (const type of others.body.items) expect(ours.has(type.id)).toBe(false);
  });

  it('[UC-CA-07] refuses bad input with the problems listed by field, and stores nothing', async () => {
    const ok = { type: 'page', title: 'Fine', slug: 'fine' };
    const bad: [string, unknown][] = [
      ['no title', { type: 'page', slug: 'fine' }],
      ['a blank title', { ...ok, title: '   ' }],
      ['a 201-character title', { ...ok, title: 't'.repeat(201) }],
      ['no slug', { type: 'page', title: 'Fine' }],
      ['an empty slug', { ...ok, slug: '' }],
      ['a slug with capitals', { ...ok, slug: 'About' }],
      ['a slug with a space', { ...ok, slug: 'about us' }],
      ['a slug with an underscore', { ...ok, slug: 'about_us' }],
      ['a slug with a leading hyphen', { ...ok, slug: '-about' }],
      ['a slug with a trailing hyphen', { ...ok, slug: 'about-' }],
      ['a slug with a double hyphen', { ...ok, slug: 'about--us' }],
      ['an 81-character slug', { ...ok, slug: 'a'.repeat(81) }],
      ['no type', { title: 'Fine', slug: 'fine' }],
      ['an unknown field', { ...ok, parentId: null }],
      ['blocks that are not a list', { ...ok, blocks: 'none' }],
      ['a block with no type', { ...ok, blocks: [{ props: {} }] }],
      [
        '201 blocks',
        {
          ...ok,
          blocks: Array.from({ length: 201 }, () => ({ type: 'text' })),
        },
      ],
      ['custom data that is a list', { ...ok, data: [] }],
      ['a body that is a list', []],
    ];
    for (const [what, body] of bad) {
      const res = await createPage(orchard.admin, body);
      expect(res.status, what).toBe(400);
      expect(res.body.message, what).toBe('Invalid request');
      expect(res.body.errors.length, what).toBeGreaterThan(0);
    }

    const unknownType = await createPage(orchard.admin, {
      ...ok,
      type: 'event',
    });
    expect(unknownType.status).toBe(400);
    expect(unknownType.body.errors.join()).toContain('type');
    expect(await countPages()).toBe(0);

    for (const query of [
      'limit=0',
      'limit=101',
      'limit=abc',
      'limit=1.5',
      'offset=-1',
      'status=bogus',
    ]) {
      const res = await api()
        .get(`/content?${query}`)
        .set(orchard.admin.headers);
      expect(res.status, query).toBe(400);
      expect(res.body.errors.length, query).toBeGreaterThan(0);
    }
  });

  it('[UC-CA-08] an address already in use is a 409, even when its page is in the trash', async () => {
    const page = await newPage(orchard.admin, 'about');
    const again = { type: 'page', title: 'Another', slug: 'about' };

    const taken = await createPage(orchard.editor, again).expect(409);
    expect(taken.body.message).toContain('/about');
    expect(await countPages()).toBe(1);

    await dataSource.query(
      'UPDATE content SET deleted_at = now() WHERE id = $1',
      [page.id],
    );
    await createPage(orchard.editor, again).expect(409);
    expect(await countPages()).toBe(1);

    // The same slug under another type has another address, so it is fine.
    await createPage(orchard.editor, {
      type: 'post',
      title: 'About',
      slug: 'about',
    }).expect(201);
  });

  it('[UC-CA-09] only a role with content.create may create', async () => {
    await createPage(orchard.viewer, {
      type: 'page',
      title: 'No',
      slug: 'no',
    }).expect(403);
    expect(await countPages()).toBe(0);

    await createPage(orchard.author, {
      type: 'page',
      title: 'By Ada',
      slug: 'by-ada',
    }).expect(201);
    await createPage(orchard.editor, {
      type: 'page',
      title: 'By Eli',
      slug: 'by-eli',
    }).expect(201);
    expect(await countPages()).toBe(2);
  });

  it('[UC-CA-10] edit_own edits only your own pages, edit_any any page, neither none', async () => {
    const byAda = await newPage(orchard.author, 'by-ada');
    const byEli = await newPage(orchard.editor, 'by-eli');

    // Refused edits first, to show they change nothing.
    const refusals: [Who, string][] = [
      [orchard.author, byEli.id],
      [orchard.viewer, byAda.id],
      [orchard.viewer, byEli.id],
    ];
    for (const [who, id] of refusals) {
      await edit(who, id, { title: 'Hijacked' }).expect(403);
    }
    expect((await storedRow(byAda.id)).title).toBe('Title by-ada');
    expect((await storedRow(byEli.id)).title).toBe('Title by-eli');

    await edit(orchard.author, byAda.id, { title: 'Ada edits Ada' }).expect(
      200,
    );
    await edit(orchard.editor, byAda.id, { title: 'Eli edits Ada' }).expect(
      200,
    );
    await edit(orchard.editor, byEli.id, { title: 'Eli edits Eli' }).expect(
      200,
    );
    await edit(orchard.admin, byEli.id, { title: 'Admin edits Eli' }).expect(
      200,
    );
    expect((await storedRow(byAda.id)).title).toBe('Eli edits Ada');
    expect((await storedRow(byEli.id)).title).toBe('Admin edits Eli');
  });

  it("[UC-CA-11] another site's pages do not exist for you, and naming a site that is not yours is a 403", async () => {
    const page = await newPage(orchard.admin, 'about');

    await api().get(`/content/${page.id}`).set(maple.admin.headers).expect(404);
    await edit(maple.admin, page.id, { title: 'Hijacked' }).expect(404);
    expect((await storedRow(page.id)).title).toBe('Title about');

    const theirs = await api()
      .get('/content')
      .set(maple.admin.headers)
      .expect(200);
    expect(theirs.body).toMatchObject({ items: [], total: 0 });

    // Addresses are unique per site: Maple can have its own /about.
    const own = await newPage(maple.admin, 'about');
    expect((await storedRow(own.id)).site_id).toBe(maple.siteId);
    expect(own.id).not.toBe(page.id);

    await api()
      .get('/content')
      .set({ ...orchard.admin.headers, 'X-Site-Id': maple.siteId })
      .expect(403);
  });

  it('[UC-CA-12] every route needs a token, a site and membership of that site', async () => {
    const routes: ['get' | 'post' | 'patch', string, object | undefined][] = [
      ['get', '/content', undefined],
      ['get', `/content/${UNKNOWN_ID}`, undefined],
      ['post', '/content', { type: 'page', title: 'T', slug: 't' }],
      ['patch', `/content/${UNKNOWN_ID}`, { title: 'T' }],
      ['get', '/content-types', undefined],
    ];
    const { Authorization } = orchard.admin.headers;

    for (const [method, path, body] of routes) {
      const label = `${method} ${path}`;
      const call = () => api()[method](path).send(body);
      expect((await call()).status, `${label} without a token`).toBe(401);
      expect(
        (await call().set('Authorization', Authorization)).status,
        `${label} without a site`,
      ).toBe(400);
      expect(
        (await call().set({ Authorization, 'X-Site-Id': maple.siteId })).status,
        `${label} on a site that is not yours`,
      ).toBe(403);
    }
    expect(await countPages()).toBe(0);
  });

  it('[UC-CA-13] a trashed page stays hidden', async () => {
    const page = await newPage(orchard.admin, 'about');
    await newPage(orchard.admin, 'contact');
    await dataSource.query(
      'UPDATE content SET deleted_at = now() WHERE id = $1',
      [page.id],
    );

    await api()
      .get(`/content/${page.id}`)
      .set(orchard.admin.headers)
      .expect(404);
    await edit(orchard.admin, page.id, { title: 'Back from the dead' }).expect(
      404,
    );

    const list = await api()
      .get('/content')
      .set(orchard.admin.headers)
      .expect(200);
    expect(list.body.total).toBe(1);
    expect(list.body.items.map((item: { slug: string }) => item.slug)).toEqual([
      'contact',
    ]);
  });
});
