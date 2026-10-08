import {
  buildContentWorld,
  type ContentWorld,
} from './support/content-world.js';

/**
 * Which blocks a page may be saved with. HTML is only safe to store once it is cleaned when it is
 * saved (BLK-05), so a `richText` block is refused for now; any other block, known or not, is
 * stored as sent. Through the real routes with real sign-ins, nothing mocked.
 */

// Making the clients hashes with production-cost scrypt (about 0.2 s each).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const HERO = { type: 'hero', headline: 'Fresh bread' };
const RICH = { type: 'richText', html: '<p>Hello</p>' };

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

const storedBlocks = async (id: string) =>
  (
    await world.dataSource.query('SELECT blocks FROM content WHERE id = $1', [
      id,
    ])
  )[0].blocks;

const edit = (id: string, body: object, who = world.orchard.admin) =>
  world.api().patch(`/content/${id}`).set(who.headers).send(body);

describe('rich text is refused until its HTML is cleaned on save', () => {
  it('[UC-RS-23] a richText block is a 400 on create, listed by position, and nothing is stored', async () => {
    const { orchard, dataSource, api } = world;

    const res = await api()
      .post('/content')
      .set(orchard.admin.headers)
      .send({
        type: 'page',
        title: 'About',
        slug: 'about',
        blocks: [HERO, RICH],
      })
      .expect(400);
    expect(res.body.message).toBe('Invalid request');
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0]).toMatch(/^blocks\.1: a richText block/);
    expect(await dataSource.query('SELECT 1 FROM content')).toEqual([]);

    // Every other block is stored as sent, even a type the site does not know.
    const fine = await api()
      .post('/content')
      .set(orchard.admin.headers)
      .send({
        type: 'page',
        title: 'About',
        slug: 'about',
        blocks: [HERO, { type: 'hologram', note: 'from the future' }],
      })
      .expect(201);
    expect(fine.body.blocks).toHaveLength(2);
  });

  it('[UC-RS-23] a richText block is a 400 on edit and the stored page is unchanged', async () => {
    const { orchard, newPage } = world;
    const page = await newPage(orchard.admin, 'about', { blocks: [HERO] });

    const res = await edit(page.id, { blocks: [HERO, RICH] }).expect(400);
    expect(res.body.errors[0]).toMatch(/^blocks\.1: a richText block/);
    expect(await storedBlocks(page.id)).toEqual([HERO]);

    await edit(page.id, { title: 'About us', blocks: [HERO, HERO] }).expect(
      200,
    );
    expect(await storedBlocks(page.id)).toEqual([HERO, HERO]);
  });

  it('[UC-RS-23] a page that already holds a richText block can still be edited, as long as that block is kept exactly', async () => {
    const { orchard, newPage, dataSource } = world;
    const page = await newPage(orchard.admin, 'old', { blocks: [HERO] });
    // From before the rule: written straight to the database.
    await dataSource.query(
      'UPDATE content SET blocks = $1::jsonb WHERE id = $2',
      [JSON.stringify([HERO, RICH]), page.id],
    );

    // Other edits are fine, with or without the block in the body (key order does not matter).
    await edit(page.id, { title: 'Old page' }).expect(200);
    const kept = { html: RICH.html, type: 'richText' };
    await edit(page.id, {
      blocks: [{ type: 'hero', headline: 'New headline' }, kept],
    }).expect(200);
    expect(await storedBlocks(page.id)).toEqual([
      { type: 'hero', headline: 'New headline' },
      RICH,
    ]);

    // Changing its HTML, or adding another one, is refused.
    await edit(page.id, {
      blocks: [HERO, { type: 'richText', html: '<script>x</script>' }],
    }).expect(400);
    await edit(page.id, {
      blocks: [HERO, RICH, { type: 'richText', html: '<p>Second</p>' }],
    }).expect(400);
    expect(await storedBlocks(page.id)).toEqual([
      { type: 'hero', headline: 'New headline' },
      RICH,
    ]);

    // Taking it out is always allowed.
    await edit(page.id, { blocks: [HERO] }).expect(200);
    expect(await storedBlocks(page.id)).toEqual([HERO]);
  });

  it('[UC-RS-23] a person who may not edit is told so (403) before anything about the blocks', async () => {
    const { orchard, newPage } = world;
    const page = await newPage(orchard.admin, 'about');

    await edit(page.id, { blocks: [RICH] }, orchard.viewer).expect(403);
    await world
      .api()
      .post('/content')
      .set(orchard.viewer.headers)
      .send({ type: 'page', title: 'Nope', slug: 'nope', blocks: [RICH] })
      .expect(403);
  });
});
