import {
  buildContentWorld,
  type ContentWorld,
  type Who,
} from './support/content-world.js';

/**
 * Making a content type on screen (TYP-01 minimum, D-043) through the real routes: real sign-ins,
 * the real public route the website reads, real Postgres. Nothing mocked.
 */

// Making the clients hashes with production-cost scrypt (about 0.2 s each).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

let world: ContentWorld;

beforeAll(async () => {
  world = await buildContentWorld();
});

beforeEach(async () => {
  await world.dataSource.query('DELETE FROM content');
  await world.dataSource.query(
    'DELETE FROM content_types WHERE is_builtin = false',
  );
});

afterAll(async () => {
  await world.close();
});

const createType = (who: Who, body: object) =>
  world.api().post('/content-types').set(who.headers).send(body);

const typeSlugs = async (who: Who) =>
  (
    await world.api().get('/content-types').set(who.headers).expect(200)
  ).body.items.map((type: { slug: string }) => type.slug);

describe('making a content type', () => {
  it('[UC-CT-01] an administrator makes "Recipe" at /recipes; its items are made like pages, live at /recipes/<slug>, are listed at /recipes with a menu link once published, and no other site has it', async () => {
    const { orchard, maple, api } = world;

    const made = await createType(orchard.admin, {
      name: '  Recipe ',
      urlPrefix: '/recipes',
    }).expect(201);
    expect(made.body).toEqual({
      id: expect.any(String),
      slug: 'recipe',
      name: 'Recipe',
      urlPrefix: '/recipes',
      hierarchical: false,
      hasCategories: false,
      hasTags: false,
      isBuiltin: false,
    });
    expect(await typeSlugs(orchard.viewer)).toEqual(['page', 'post', 'recipe']);
    expect(await typeSlugs(maple.admin)).toEqual(['page', 'post']);

    // Nothing published yet: the list is there and empty, and the menu has no link to it.
    const empty = await api()
      .get('/public/site?host=orchard.test&path=/recipes')
      .expect(200);
    expect(empty.body).toMatchObject({
      kind: 'listing',
      listing: { title: 'Recipes', path: '/recipes', items: [], total: 0 },
    });
    expect(empty.body.navigation).not.toContainEqual(
      expect.objectContaining({ path: '/recipes' }),
    );

    // An item, made and published as a page is.
    const item = await api()
      .post('/content')
      .set(orchard.admin.headers)
      .send({
        type: 'recipe',
        title: 'Seeded rye',
        slug: 'seeded-rye',
        blocks: [{ type: 'hero', headline: 'Seeded rye' }],
      })
      .expect(201);
    expect(item.body).toMatchObject({
      path: '/recipes/seeded-rye',
      type: { slug: 'recipe', name: 'Recipe' },
    });
    await api()
      .post(`/content/${item.body.id}/publish`)
      .set(orchard.admin.headers)
      .expect(200);

    const page = await api()
      .get('/public/site?host=orchard.test&path=/recipes/seeded-rye')
      .expect(200);
    expect(page.body.page).toMatchObject({
      title: 'Seeded rye',
      blocks: [{ type: 'hero', headline: 'Seeded rye' }],
    });
    expect(page.body.navigation).toContainEqual({
      title: 'Recipes',
      path: '/recipes',
    });
    const listed = await api()
      .get('/public/site?host=orchard.test&path=/recipes')
      .expect(200);
    expect(listed.body.listing).toMatchObject({
      title: 'Recipes',
      total: 1,
      items: [{ title: 'Seeded rye', path: '/recipes/seeded-rye' }],
    });

    // Another site's address does not have it.
    await api().get('/public/site?host=maple.test&path=/recipes').expect(404);
    await api()
      .post('/content')
      .set(maple.admin.headers)
      .send({ type: 'recipe', title: 'Nope', slug: 'nope' })
      .expect(400);
  });

  it('[UC-CT-02] a name or address that cannot be used, one already taken, a page at that address, or someone without content_types.manage is refused, and nothing is made', async () => {
    const { orchard, api } = world;
    const about = await world.newPage(orchard.admin, 'about');
    expect(about.path).toBe('/about');

    const refused: [object, string][] = [
      [{ urlPrefix: '/recipes' }, 'name'],
      [{ name: '', urlPrefix: '/recipes' }, 'name'],
      [{ name: 'x'.repeat(61), urlPrefix: '/recipes' }, 'name'],
      [{ name: '!!!', urlPrefix: '/recipes' }, 'name'],
      [{ name: 'Recipe' }, 'urlPrefix'],
      [{ name: 'Recipe', urlPrefix: 'recipes' }, 'urlPrefix'],
      [{ name: 'Recipe', urlPrefix: '/Recipes' }, 'urlPrefix'],
      [{ name: 'Recipe', urlPrefix: '/recipes/cakes' }, 'urlPrefix'],
      [{ name: 'Recipe', urlPrefix: '/re cipes' }, 'urlPrefix'],
      [{ name: 'Recipe', urlPrefix: '/api' }, 'urlPrefix'],
      [{ name: 'Recipe', urlPrefix: '/home' }, 'urlPrefix'],
      [{ name: 'Recipe', urlPrefix: '/recipes', fields: [] }, 'body'],
    ];
    for (const [body, field] of refused) {
      const res = await createType(orchard.admin, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.errors[0], JSON.stringify(body)).toMatch(
        new RegExp(`^${field}: `),
      );
    }

    // Taken: a type's name (any capitals) or address, or a page's address.
    const taken = await createType(orchard.admin, {
      name: 'POST',
      urlPrefix: '/articles',
    }).expect(409);
    expect(taken.body.message).toBe(
      'This site already has a content type called Post',
    );
    const blog = await createType(orchard.admin, {
      name: 'Article',
      urlPrefix: '/blog',
    }).expect(409);
    expect(blog.body.message).toBe(
      'Post already uses /blog; pick another address',
    );
    const page = await createType(orchard.admin, {
      name: 'About item',
      urlPrefix: '/about',
    }).expect(409);
    expect(page.body.message).toBe(
      'A page already uses /about; pick another address',
    );

    // Permission is checked first.
    await createType(orchard.editor, {
      name: 'Recipe',
      urlPrefix: '/recipes',
    }).expect(403);
    await api()
      .post('/content-types')
      .send({ name: 'Recipe', urlPrefix: '/recipes' })
      .expect(401);

    expect(await typeSlugs(orchard.admin)).toEqual(['page', 'post']);
  });
});
