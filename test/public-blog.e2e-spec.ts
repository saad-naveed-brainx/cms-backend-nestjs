import {
  buildContentWorld,
  type ContentWorld,
  type Who,
} from './support/content-world.js';

/**
 * The blog page (feature blog-page): at a type's own address (`/blog` for posts), with no page made
 * there, the public route lists that type's published items, newest first. Through the real routes,
 * with two real clients; nothing mocked.
 */

// Making the clients hashes with production-cost scrypt (about 0.2 s each).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

let world: ContentWorld;

beforeAll(async () => {
  world = await buildContentWorld();
});

beforeEach(async () => {
  await world.dataSource.query('DELETE FROM content');
});

afterAll(async () => {
  await world.close();
});

const publicSite = (host: string, path: string, page?: string) => {
  const query = new URLSearchParams({ host, path });
  if (page !== undefined) query.set('page', page);
  return world.api().get(`/public/site?${query}`);
};

/** A post (or page) made and published through the real routes, published at a set time. */
async function publish(who: Who, slug: string, at: string, type = 'post') {
  const made = await world.newPage(who, slug, { type, title: `Title ${slug}` });
  await world
    .api()
    .post(`/content/${made.id}/publish`)
    .set(who.headers)
    .expect(200);
  await world.dataSource.query(
    'UPDATE content SET published_at = $1 WHERE id = $2',
    [at, made.id],
  );
  return made;
}

describe('the blog page', () => {
  it('[UC-BP-01] lists the site’s published posts at /blog, newest first, and nothing else', async () => {
    const { orchard, maple } = world;
    await publish(orchard.admin, 'older', '2026-10-01T09:00:00Z');
    await publish(orchard.admin, 'newer', '2026-10-05T09:00:00Z');
    await publish(orchard.admin, 'about', '2026-10-06T09:00:00Z', 'page');
    await world.newPage(orchard.admin, 'draft-post', { type: 'post' });
    await publish(maple.admin, 'maple-post', '2026-10-07T09:00:00Z');

    const res = await publicSite('orchard.test', '/blog').expect(200);
    expect(res.body.kind).toBe('listing');
    expect(res.body.listing).toEqual({
      title: 'Posts',
      path: '/blog',
      items: [
        {
          title: 'Title newer',
          path: '/blog/newer',
          publishedAt: '2026-10-05T09:00:00.000Z',
        },
        {
          title: 'Title older',
          path: '/blog/older',
          publishedAt: '2026-10-01T09:00:00.000Z',
        },
      ],
      page: 1,
      pageSize: 10,
      total: 2,
    });
    expect(res.body.site.name).toBe('Orchard Bakery');
    // The menu links to it, and to the page; nothing internal leaves.
    expect(res.body.navigation).toEqual([
      { title: 'Title about', path: '/about' },
      { title: 'Posts', path: '/blog' },
    ]);
    expect(JSON.stringify(res.body)).not.toContain(orchard.siteId);
  });

  it('[UC-BP-02] pages through ten at a time; past the end is a 404, and a bad page number a 400', async () => {
    const { orchard } = world;
    for (let n = 1; n <= 12; n += 1) {
      await publish(
        orchard.admin,
        `post-${n}`,
        `2026-10-01T${String(n).padStart(2, '0')}:00:00Z`,
      );
    }

    const first = await publicSite('orchard.test', '/blog').expect(200);
    expect(first.body.listing.items).toHaveLength(10);
    expect(first.body.listing.items[0].title).toBe('Title post-12');
    expect(first.body.listing.total).toBe(12);

    const second = await publicSite('orchard.test', '/blog', '2').expect(200);
    expect(
      second.body.listing.items.map((item: { title: string }) => item.title),
    ).toEqual(['Title post-2', 'Title post-1']);
    expect(second.body.listing.page).toBe(2);

    await publicSite('orchard.test', '/blog', '3').expect(404);
    for (const bad of ['0', '-1', 'two', '1.5', '1001']) {
      await publicSite('orchard.test', '/blog', bad).expect(400);
    }
  });

  it('[UC-BP-03] with nothing published the blog page is empty and not in the menu; a page made at /blog wins', async () => {
    const { orchard } = world;

    const empty = await publicSite('orchard.test', '/blog').expect(200);
    expect(empty.body.listing).toMatchObject({ items: [], total: 0 });
    expect(empty.body.navigation).toEqual([]);

    // An address that is no type's is still a 404.
    await publicSite('orchard.test', '/news').expect(404);

    await publish(orchard.admin, 'blog', '2026-10-01T09:00:00Z', 'page');
    const page = await publicSite('orchard.test', '/blog').expect(200);
    expect(page.body.kind).toBe('page');
    expect(page.body.page.title).toBe('Title blog');
  });
});
