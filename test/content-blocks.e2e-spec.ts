import {
  buildContentWorld,
  type ContentWorld,
} from './support/content-world.js';

/**
 * Which blocks a page may be saved with. A text block (`richText`) holds HTML, which is cleaned
 * when the page is saved (BLK-05, D-041), so what is stored is safe to draw as it is; any other
 * block, known or not, is stored as sent. Through the real routes with real sign-ins, nothing mocked.
 */

// Making the clients hashes with production-cost scrypt (about 0.2 s each).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const HERO = { type: 'hero', headline: 'Fresh bread' };

/** Everything a text block may hold, which is kept exactly. */
const KEPT =
  '<h2>Our story</h2><p>We bake <strong>every</strong> morning, <em>early</em>. <u>Really</u> <s>late</s>.<br />Since 1990.</p>' +
  '<h3>Visit</h3><ul><li>Bread</li><li>Cakes</li></ul><ol><li>Order</li></ol>' +
  '<blockquote><p>Best rye in town.</p></blockquote>' +
  '<p><a href="https://example.com/rye">Recipe</a> <a href="/about">About</a> <a href="mailto:hi@orchard.test">Email</a> <a href="tel:+441234">Call</a> <a href="#hours">Hours</a></p>';

/** Everything that must not survive, each next to words that must. */
const DIRTY =
  '<p onclick="steal()" style="color:red" class="x">Hello<script>alert(1)</script></p>' +
  '<img src="x" onerror="alert(1)"><iframe src="https://evil.test"></iframe>' +
  '<p><a href="javascript:alert(1)">bad link</a> <a href="//evil.test">sneaky</a> <a href="https://ok.test" target="_blank" onmouseover="x()">ok</a></p>' +
  '<style>body{display:none}</style><div><span>Kept words</span></div>' +
  '<h1>Big</h1><b>bold</b> <i>italic</i>';

const CLEANED =
  '<p>Hello</p>' +
  '<p><a>bad link</a> <a>sneaky</a> <a href="https://ok.test">ok</a></p>' +
  'Kept words' +
  '<h2>Big</h2><strong>bold</strong> <em>italic</em>';

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

const create = (body: object, who = world.orchard.admin) =>
  world
    .api()
    .post('/content')
    .set(who.headers)
    .send({ type: 'page', title: 'About', slug: 'about', ...body });

describe('text blocks are cleaned when a page is saved', () => {
  it('[UC-TB-01] the formatting a text block may hold is stored exactly; everything else is taken out, keeping the words; the website is sent what is stored', async () => {
    const { api } = world;

    const made = await create({
      blocks: [
        HERO,
        { type: 'richText', heading: '  Hello  ', html: KEPT, extra: 'x' },
        { type: 'richText', html: DIRTY },
        { type: 'hologram', note: 'from the future' },
      ],
    }).expect(201);
    const expected = [
      HERO,
      { type: 'richText', heading: 'Hello', html: KEPT },
      { type: 'richText', html: CLEANED },
      { type: 'hologram', note: 'from the future' },
    ];
    expect(made.body.blocks).toEqual(expected);
    expect(await storedBlocks(made.body.id)).toEqual(expected);

    // Editing cleans too, and an empty heading is left out.
    await edit(made.body.id, {
      blocks: [{ type: 'richText', heading: ' ', html: DIRTY }],
    }).expect(200);
    expect(await storedBlocks(made.body.id)).toEqual([
      { type: 'richText', html: CLEANED },
    ]);

    // Published, the public answer carries the cleaned text.
    await api()
      .post(`/content/${made.body.id}/publish`)
      .set(world.orchard.admin.headers)
      .expect(200);
    const page = await api()
      .get('/public/site?host=orchard.test&path=/about')
      .expect(200);
    expect(page.body.page.blocks).toEqual([
      { type: 'richText', html: CLEANED },
    ]);
  });

  it('[UC-TB-02] a text block with no html, too much of it, or a heading that is not short text is a 400 listed by position, and nothing is stored or changed', async () => {
    const { dataSource } = world;

    const res = await create({
      blocks: [
        HERO,
        { type: 'richText' },
        { type: 'richText', html: 'x'.repeat(50_001) },
        { type: 'richText', html: '<p>Fine</p>', heading: 7 },
        { type: 'richText', html: '<p>Fine</p>', heading: 'h'.repeat(201) },
      ],
    }).expect(400);
    expect(res.body.message).toBe('Invalid request');
    expect(res.body.errors).toEqual([
      'blocks.1: a richText block needs its text as html',
      'blocks.2: a richText block holds at most 50000 characters',
      'blocks.3: a richText heading is text of at most 200 characters',
      'blocks.4: a richText heading is text of at most 200 characters',
    ]);
    expect(await dataSource.query('SELECT 1 FROM content')).toEqual([]);

    const page = await world.newPage(world.orchard.admin, 'about', {
      blocks: [HERO],
    });
    await edit(page.id, { blocks: [{ type: 'richText', html: 3 }] }).expect(
      400,
    );
    expect(await storedBlocks(page.id)).toEqual([HERO]);
  });

  it('[UC-TB-02] a person who may not edit is told so (403) before anything about the blocks', async () => {
    const { orchard, newPage } = world;
    const page = await newPage(orchard.admin, 'about');

    await edit(
      page.id,
      { blocks: [{ type: 'richText' }] },
      orchard.viewer,
    ).expect(403);
    await create({ blocks: [{ type: 'richText' }] }, orchard.viewer).expect(
      403,
    );
  });
});
