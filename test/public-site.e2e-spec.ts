import { SiteResolver } from '../src/sites/site-resolver.service.js';
import {
  buildContentWorld,
  type ContentWorld,
  type Who,
} from './support/content-world.js';
import { withSqlCount } from './support/sql-count.js';

/**
 * What the public website reads (CNT-07), through the real route with no token: pages made and
 * published through the real content routes by real sign-ins, two real clients, nothing mocked.
 */

// Making the clients hashes with production-cost scrypt (about 0.2 s each).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const ORCHARD_THEME = {
  typeSet: 'editorial',
  palette: { paper: '#fffaf0', brand: '#8a3b12' },
};
const MAPLE_THEME = { typeSet: 'technical', palette: { paper: '#0b1020' } };

const HERO = {
  type: 'hero',
  headline: 'Fresh bread, every morning',
  body: 'Baked at dawn.',
};
const CTA = {
  type: 'cta',
  heading: 'Visit us',
  action: { label: 'Find the shop', href: '/contact' },
};

let world: ContentWorld;

beforeAll(async () => {
  world = await buildContentWorld();
  // A theme is set by hand: nothing in the API changes one yet. The host lookup remembers a site
  // for a minute, so it is told about the change.
  await world.dataSource.query('UPDATE sites SET theme = $1 WHERE id = $2', [
    JSON.stringify(ORCHARD_THEME),
    world.orchard.siteId,
  ]);
  await world.dataSource.query('UPDATE sites SET theme = $1 WHERE id = $2', [
    JSON.stringify(MAPLE_THEME),
    world.maple.siteId,
  ]);
  const resolver = world.app.get(SiteResolver);
  resolver.invalidateSite(world.orchard.siteId);
  resolver.invalidateSite(world.maple.siteId);
});

beforeEach(async () => {
  await world.dataSource.query('DELETE FROM content');
});

afterAll(async () => {
  await world.close();
});

/** The public route: no token, no site header. */
const publicSite = (host: string | undefined, path?: string | string[]) => {
  const query = new URLSearchParams();
  if (host !== undefined) query.set('host', host);
  for (const value of [path ?? []].flat()) query.append('path', value);
  return world.api().get(`/public/site?${query}`);
};

/** A page made through the real route, then published through the real route. */
async function live(who: Who, slug: string, extra: object = {}) {
  const page = await world.newPage(who, slug, extra);
  await world
    .api()
    .post(`/content/${page.id}/publish`)
    .set(who.headers)
    .expect(200);
  return page;
}

describe('a published page by address', () => {
  it('[UC-RS-14] gives the page, the site name and theme and the navigation, and nothing internal, with no token', async () => {
    const { orchard } = world;
    const home = await live(orchard.admin, 'home', {
      title: 'Orchard home',
      blocks: [HERO, CTA],
    });
    await live(orchard.admin, 'contact', { title: 'Contact' });
    await live(orchard.admin, 'about', { title: 'About us' });
    // Not in the navigation: a post (it gives the blog page its link instead), a draft and the home page itself.
    await live(orchard.admin, 'hello', { title: 'A post', type: 'post' });
    await world.newPage(orchard.admin, 'secret', { title: 'Draft only' });

    const res = await publicSite('orchard.test', '/').expect(200);
    expect(res.body).toEqual({
      kind: 'page',
      site: { name: 'Orchard Bakery', theme: ORCHARD_THEME, settings: {} },
      host: 'orchard.test',
      canonicalHost: 'orchard.test',
      page: {
        title: 'Orchard home',
        path: '/home',
        seoTitle: null,
        seoDescription: null,
        noIndex: false,
        publishedAt: expect.any(String),
        blocks: [HERO, CTA],
      },
      navigation: [
        { title: 'About us', path: '/about' },
        { title: 'Contact', path: '/contact' },
        { title: 'Posts', path: '/blog' },
      ],
    });

    // Nothing that identifies a row or a person.
    const text = JSON.stringify(res.body);
    for (const internal of [
      orchard.siteId,
      home.id,
      orchard.admin.userId,
      orchard.publisher.userId,
    ]) {
      expect(text).not.toContain(internal);
    }

    // The address is tidied the way the host lookup tidies it, and another page is found by its path.
    const other = await publicSite('Orchard.TEST:3000', '/about/').expect(200);
    expect(other.body.page).toMatchObject({
      title: 'About us',
      path: '/about',
      blocks: [],
    });
    expect(other.body.host).toBe('orchard.test');
  });

  it('[UC-RS-14] the navigation is the first published top-level pages by title, never a child, a post or a draft, then the blog link, eight in all', async () => {
    const { orchard, dataSource } = world;
    await live(orchard.admin, 'home', { title: 'Home' });
    const top = await live(orchard.admin, 'zz-parent', {
      title: 'ZZ Parent',
    });
    for (let n = 1; n <= 9; n += 1) {
      await live(orchard.admin, `page-${n}`, { title: `Page ${n}` });
    }
    // Sort before every other title, so they would lead the list if they were let in.
    const child = await live(orchard.admin, 'aaa-child', {
      title: 'AAA Child',
    });
    await dataSource.query('UPDATE content SET parent_id = $1 WHERE id = $2', [
      top.id,
      child.id,
    ]);
    await live(orchard.admin, 'aaa-post', { title: 'AAA Post', type: 'post' });
    await world.newPage(orchard.admin, 'aaa-draft', { title: 'AAA Draft' });

    const res = await publicSite('orchard.test', '/').expect(200);
    // A published post is not a link of its own; it gives the blog page its link, which is kept.
    expect(res.body.navigation).toEqual([
      ...[
        'Page 1',
        'Page 2',
        'Page 3',
        'Page 4',
        'Page 5',
        'Page 6',
        'Page 7',
      ].map((title, index) => ({ title, path: `/page-${index + 1}` })),
      { title: 'Posts', path: '/blog' },
    ]);
  });
});

describe('what is not public stays out', () => {
  it('[UC-RS-15] a draft, an unpublished page and a page waiting for review or a date are a 404', async () => {
    const { orchard, dataSource, api } = world;
    const page = await world.newPage(orchard.admin, 'about', {
      title: 'About us',
    });
    const asked = () => publicSite('orchard.test', '/about');

    const draft = await asked().expect(404);
    expect(draft.body.message).toBe('Page not found');

    await api()
      .post(`/content/${page.id}/publish`)
      .set(orchard.publisher.headers)
      .expect(200);
    await asked().expect(200);

    await api()
      .post(`/content/${page.id}/unpublish`)
      .set(orchard.publisher.headers)
      .expect(200);
    await asked().expect(404);

    await dataSource.query(
      "UPDATE content SET status = 'pending_review' WHERE id = $1",
      [page.id],
    );
    await asked().expect(404);
    await dataSource.query(
      "UPDATE content SET status = 'scheduled', scheduled_at = now() + interval '1 day' WHERE id = $1",
      [page.id],
    );
    await asked().expect(404);
  });

  it("[UC-RS-15] a trashed page, an unknown path and another site's page are a 404", async () => {
    const { orchard, maple, dataSource } = world;
    const trashed = await live(orchard.admin, 'gone', { title: 'Gone' });
    await dataSource.query(
      'UPDATE content SET deleted_at = now() WHERE id = $1',
      [trashed.id],
    );
    await live(maple.admin, 'maple-only', { title: 'Maple only' });
    await live(orchard.admin, 'about', { title: 'About us' });

    for (const path of ['/gone', '/nothing-here', '/a/b/c', '/About']) {
      await publicSite('orchard.test', path).expect(404);
    }
    // Maple's page is Maple's, and only on Maple's address.
    await publicSite('orchard.test', '/maple-only').expect(404);
    const mine = await publicSite('maple.test', '/maple-only').expect(200);
    expect(mine.body.page.title).toBe('Maple only');
    await publicSite('maple.test', '/about').expect(404);
  });

  it('[UC-RS-15] / serves the page at /home, and a site with no published home page has none to show', async () => {
    const { orchard } = world;
    await publicSite('orchard.test', '/').expect(404);

    const home = await world.newPage(orchard.admin, 'home', {
      title: 'Orchard home',
    });
    await publicSite('orchard.test', '/').expect(404);

    await world
      .api()
      .post(`/content/${home.id}/publish`)
      .set(orchard.admin.headers)
      .expect(200);
    for (const path of ['/', '/home', '/home/']) {
      const res = await publicSite('orchard.test', path).expect(200);
      expect(res.body.page).toMatchObject({
        title: 'Orchard home',
        path: '/home',
      });
    }
  });

  it('[UC-RS-15] the same path on two hosts gives each site its own page, name and theme', async () => {
    const { orchard, maple } = world;
    await live(orchard.admin, 'about', {
      title: 'About Orchard',
      blocks: [{ type: 'testimonial', quote: 'Lovely', attribution: 'Ann' }],
    });
    await live(maple.admin, 'about', { title: 'About Maple' });

    const first = await publicSite('orchard.test', '/about').expect(200);
    const second = await publicSite('maple.test', '/about').expect(200);
    expect(first.body).toMatchObject({
      site: { name: 'Orchard Bakery', theme: ORCHARD_THEME },
      page: { title: 'About Orchard', path: '/about' },
      navigation: [{ title: 'About Orchard', path: '/about' }],
    });
    expect(first.body.page.blocks).toHaveLength(1);
    expect(second.body).toMatchObject({
      site: { name: 'Maple Books', theme: MAPLE_THEME },
      page: { title: 'About Maple', path: '/about', blocks: [] },
      navigation: [{ title: 'About Maple', path: '/about' }],
    });
  });
});

describe('bad lookups', () => {
  it('[UC-RS-16] a missing, malformed or repeated host or path is a 400 decided before any database call, and an unknown host is a 404', async () => {
    const { dataSource } = world;
    const bad: [string, () => ReturnType<typeof publicSite>][] = [
      ['no host', () => publicSite(undefined, '/')],
      ['a blank host', () => publicSite('', '/')],
      ['a host with a space', () => publicSite('a b.test', '/')],
      ['a host with a slash', () => publicSite('orchard.test/x', '/')],
      [
        'a host given twice',
        () =>
          world
            .api()
            .get('/public/site?host=orchard.test&host=maple.test&path=/'),
      ],
      ['no path', () => publicSite('orchard.test')],
      ['a blank path', () => publicSite('orchard.test', '')],
      [
        'a path with no leading slash',
        () => publicSite('orchard.test', 'about'),
      ],
      ['a path with a query', () => publicSite('orchard.test', '/about?x=1')],
      ['a path with a hash', () => publicSite('orchard.test', '/about#top')],
      ['a path with an empty part', () => publicSite('orchard.test', '/a//b')],
      ['a path with two slashes', () => publicSite('orchard.test', '//')],
      ['a path that climbs', () => publicSite('orchard.test', '/../etc')],
      ['a path with a space', () => publicSite('orchard.test', '/a b')],
      ['a path with an escape', () => publicSite('orchard.test', '/a%20b')],
      ['a path with an accent', () => publicSite('orchard.test', '/café')],
      [
        'a path with a trailing hyphen',
        () => publicSite('orchard.test', '/about-'),
      ],
      [
        'a path of 301 characters',
        () => publicSite('orchard.test', `/${'a'.repeat(300)}`),
      ],
      [
        'a path given twice',
        () => publicSite('orchard.test', ['/about', '/contact']),
      ],
    ];
    for (const [what, call] of bad) {
      const { result, sql } = await withSqlCount(dataSource, async () =>
        call(),
      );
      expect(result.status, what).toBe(400);
      expect(sql, what).toEqual([]);
    }

    // A bad path wins over an unknown host: it is decided first.
    await publicSite('nobody.test', '/a b').expect(400);
    // A well-formed address nobody answers on.
    const unknown = await publicSite('nobody.test', '/').expect(404);
    expect(unknown.body.message).toBe('No site answers on this address');
  });
});
