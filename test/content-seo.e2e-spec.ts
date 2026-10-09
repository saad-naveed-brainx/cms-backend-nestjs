import {
  buildContentWorld,
  type ContentWorld,
  type Who,
} from './support/content-world.js';

/**
 * A page's search-engine fields (SEO-01): its own title and description for search results, the
 * address search engines should treat as its original, and "hide from search engines". Set on
 * create and on edit, returned with the page, and handed to the website with the published page.
 * Through the real routes, with two real clients; nothing mocked.
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

const edit = (who: Who, id: string, body: object) =>
  world.api().patch(`/content/${id}`).set(who.headers).send(body);

/** The page's search fields as the database holds them. */
async function storedSeo(id: string) {
  const [row] = await world.dataSource.query(
    'SELECT seo_title, seo_description, canonical_url, no_index, updated_at FROM content WHERE id = $1',
    [id],
  );
  return row;
}

describe('page search fields', () => {
  it('[UC-SEO-01] sets the search fields on create and on edit, returns them with the page, and an empty one clears it', async () => {
    const { admin, editor } = world.orchard;
    const made = await world.newPage(admin, 'menu', {
      seoTitle: '  Our menu | Orchard Bakery ',
      seoDescription: 'Bread, buns and cakes, baked every morning.',
      canonicalUrl: 'https://orchard.example/menu',
      noIndex: true,
    });
    expect(made).toMatchObject({
      seoTitle: 'Our menu | Orchard Bakery',
      seoDescription: 'Bread, buns and cakes, baked every morning.',
      canonicalUrl: 'https://orchard.example/menu',
      noIndex: true,
    });

    // A page made without them has none, and is not hidden.
    const plain = await world.newPage(admin, 'plain');
    expect(plain).toMatchObject({
      seoTitle: null,
      seoDescription: null,
      canonicalUrl: null,
      noIndex: false,
    });

    const read = await world
      .api()
      .get(`/content/${made.id}`)
      .set(world.orchard.viewer.headers)
      .expect(200);
    expect(read.body).toMatchObject({
      seoTitle: 'Our menu | Orchard Bakery',
      canonicalUrl: 'https://orchard.example/menu',
      noIndex: true,
    });

    // Only what is sent changes; an empty text clears the field.
    const edited = await edit(editor, made.id, {
      seoTitle: '   ',
      canonicalUrl: '',
      noIndex: false,
    }).expect(200);
    expect(edited.body).toMatchObject({
      title: 'Title menu',
      seoTitle: null,
      seoDescription: 'Bread, buns and cakes, baked every morning.',
      canonicalUrl: null,
      noIndex: false,
      updatedBy: editor.userId,
    });
    expect(await storedSeo(made.id)).toMatchObject({
      seo_title: null,
      seo_description: 'Bread, buns and cakes, baked every morning.',
      canonical_url: null,
      no_index: false,
    });

    // `null` clears too.
    const cleared = await edit(editor, made.id, {
      seoDescription: null,
    }).expect(200);
    expect(cleared.body.seoDescription).toBeNull();

    // The list stays light: no search fields in its rows.
    const list = await world
      .api()
      .get('/content')
      .set(admin.headers)
      .expect(200);
    for (const item of list.body.items)
      expect(item).not.toHaveProperty('seoTitle');
  });

  it('[UC-SEO-02] refuses a search field it cannot use, says which, and stores nothing', async () => {
    const { admin } = world.orchard;
    const page = await world.newPage(admin, 'about', {
      seoTitle: 'About us',
      canonicalUrl: 'https://orchard.example/about',
    });
    const before = await storedSeo(page.id);

    const refused: [object, string][] = [
      [{ seoTitle: 'x'.repeat(201) }, 'seoTitle'],
      [{ seoTitle: 5 }, 'seoTitle'],
      [{ seoDescription: 'x'.repeat(501) }, 'seoDescription'],
      [{ canonicalUrl: 'javascript:alert(1)' }, 'canonicalUrl'],
      [{ canonicalUrl: '/about' }, 'canonicalUrl'],
      [{ canonicalUrl: 'ftp://orchard.example/about' }, 'canonicalUrl'],
      [{ canonicalUrl: 'orchard.example/about' }, 'canonicalUrl'],
      [
        { canonicalUrl: `https://orchard.example/${'a'.repeat(2000)}` },
        'canonicalUrl',
      ],
      [{ noIndex: 'yes' }, 'noIndex'],
      [{ ogImageId: '0198f2a0-0000-7000-8000-000000000999' }, 'ogImageId'],
    ];
    for (const [body, field] of refused) {
      const refusal = await edit(admin, page.id, body);
      expect(refusal.status, JSON.stringify(body)).toBe(400);
      expect(refusal.body.errors.join(' '), JSON.stringify(body)).toContain(
        field,
      );
    }
    expect(await storedSeo(page.id)).toEqual(before);

    // The same rules on create: nothing is made.
    const created = await world
      .api()
      .post('/content')
      .set(admin.headers)
      .send({
        type: 'page',
        title: 'Bad',
        slug: 'bad',
        canonicalUrl: 'javascript:alert(1)',
      });
    expect(created.status).toBe(400);
    const [{ count }] = await world.dataSource.query(
      "SELECT count(*)::int AS count FROM content WHERE slug = 'bad'",
    );
    expect(count).toBe(0);
  });

  it('[UC-SEO-03] hands the search fields to the website with the published page and the preview, and nothing of another site', async () => {
    const { admin } = world.orchard;
    const page = await world.newPage(admin, 'visit', {
      seoTitle: 'Visit the bakery',
      seoDescription: 'Open every day from seven.',
      canonicalUrl: 'https://orchard.example/visit',
    });
    await world
      .api()
      .post(`/content/${page.id}/publish`)
      .set(admin.headers)
      .expect(200);

    const seen = await world
      .api()
      .get('/public/site?host=orchard.test&path=/visit')
      .expect(200);
    expect(seen.body.page).toMatchObject({
      title: 'Title visit',
      seoTitle: 'Visit the bakery',
      seoDescription: 'Open every day from seven.',
      canonicalUrl: 'https://orchard.example/visit',
      noIndex: false,
    });

    // Hiding a live page from search engines is a change the website sees.
    await edit(admin, page.id, { noIndex: true }).expect(200);
    const hidden = await world
      .api()
      .get('/public/site?host=orchard.test&path=/visit')
      .expect(200);
    expect(hidden.body.page.noIndex).toBe(true);

    // The preview carries them too, and is never indexed.
    const link = await world
      .api()
      .post(`/content/${page.id}/preview`)
      .set(admin.headers)
      .expect(200);
    const preview = await world
      .api()
      .get(
        `/public/preview?host=orchard.test&token=${encodeURIComponent(link.body.token)}`,
      )
      .expect(200);
    expect(preview.body.page).toMatchObject({
      seoTitle: 'Visit the bakery',
      canonicalUrl: 'https://orchard.example/visit',
      noIndex: true,
    });

    // Another site's address does not show this page or its fields.
    await world
      .api()
      .get('/public/site?host=maple.test&path=/visit')
      .expect(404);
  });
});
