import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SiteResolver } from '../src/sites/site-resolver.service.js';
import {
  buildContentWorld,
  type ContentWorld,
} from './support/content-world.js';

/**
 * A site's appearance (GOV-04): its name, the tagline beside it in the header, the note in its
 * footer, and its theme (palette, type set, shape, density, texture). Read by any member, saved by
 * whoever holds `settings.manage`, through the real routes with two real clients. A small stand-in
 * for the website records what it is told after a save, as in production.
 */

// Making the clients hashes with production-cost scrypt (about 0.2 s each).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const SECRET = 'test-revalidate-secret';

let world: ContentWorld;
let website: Server;
let told: { path: string; body: unknown }[] = [];

const HARBOUR = {
  typeSet: 'technical',
  shape: 'sharp',
  density: 'tight',
  texture: 'grid',
  palette: {
    paper: '#f4f1ea',
    surface: '#ffffff',
    ink: '#13201c',
    muted: '#53625d',
    line: '#d3cdbf',
    brand: '#0f5c4d',
    onBrand: '#ffffff',
    accent: 'oklch(0.7 0.15 60)',
  },
};

beforeAll(async () => {
  website = createServer((request, response) => {
    let data = '';
    request.on('data', (chunk) => (data += chunk));
    request.on('end', () => {
      told.push({
        path: request.url ?? '',
        body: data ? JSON.parse(data) : null,
      });
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

beforeEach(async () => {
  await world.dataSource.query('DELETE FROM content');
  await world.dataSource.query(
    `UPDATE sites SET name = CASE WHEN id = $1 THEN 'Orchard Bakery' ELSE name END, theme = '{}', settings = '{}'`,
    [world.orchard.siteId],
  );
  // Reset behind the API's back, so its remembered address lookups go too.
  world.app.get(SiteResolver).invalidateAll();
  told = [];
});

afterAll(async () => {
  process.env.WEB_REVALIDATE_URL = '';
  delete process.env.REVALIDATE_SECRET;
  await world.close();
  await new Promise<void>((resolve) => website.close(() => resolve()));
});

const read = (headers: Record<string, string>) =>
  world.api().get('/appearance').set(headers);
const save = (headers: Record<string, string>, body: object) =>
  world.api().patch('/appearance').set(headers).send(body);

async function storedSite(siteId: string) {
  const [row] = await world.dataSource.query(
    'SELECT name, theme, settings FROM sites WHERE id = $1',
    [siteId],
  );
  return row;
}

describe('a site’s appearance', () => {
  it('[UC-AP-01] saves the name, tagline, footer note and theme, reads them back, and the public site carries them', async () => {
    const { admin, viewer, siteId } = world.orchard;
    // A new site: its own name, nothing else set.
    expect((await read(viewer.headers).expect(200)).body).toEqual({
      name: 'Orchard Bakery',
      tagline: '',
      footerNote: '',
      theme: {},
    });

    // Other settings already stored are kept.
    await world.dataSource.query(
      `UPDATE sites SET settings = '{"keep":"me"}' WHERE id = $1`,
      [siteId],
    );
    const saved = await save(admin.headers, {
      name: '  Orchard Bakery & Café ',
      tagline: ' Baked at five, every morning ',
      footerNote: '12 Harbour Street · Open daily from 7',
      theme: HARBOUR,
    }).expect(200);
    const expected = {
      name: 'Orchard Bakery & Café',
      tagline: 'Baked at five, every morning',
      footerNote: '12 Harbour Street · Open daily from 7',
      theme: HARBOUR,
    };
    expect(saved.body).toEqual(expected);
    expect((await read(viewer.headers).expect(200)).body).toEqual(expected);
    expect(await storedSite(siteId)).toEqual({
      name: 'Orchard Bakery & Café',
      theme: HARBOUR,
      settings: {
        keep: 'me',
        tagline: 'Baked at five, every morning',
        footerNote: '12 Harbour Street · Open daily from 7',
      },
    });

    const page = await world.newPage(admin, 'home', { title: 'Home' });
    await world
      .api()
      .post(`/content/${page.id}/publish`)
      .set(admin.headers)
      .expect(200);
    const home = await world
      .api()
      .get('/public/site?host=orchard.test&path=/')
      .expect(200);
    expect(home.body.site).toEqual({
      name: 'Orchard Bakery & Café',
      theme: HARBOUR,
      settings: {
        keep: 'me',
        tagline: 'Baked at five, every morning',
        footerNote: '12 Harbour Street · Open daily from 7',
      },
    });

    // Only what is sent changes; an empty tagline clears it.
    const cleared = await save(admin.headers, { tagline: '   ' }).expect(200);
    expect(cleared.body).toMatchObject({
      name: 'Orchard Bakery & Café',
      tagline: '',
      footerNote: '12 Harbour Street · Open daily from 7',
      theme: HARBOUR,
    });
    expect((await storedSite(siteId)).settings).toEqual({
      keep: 'me',
      footerNote: '12 Harbour Street · Open daily from 7',
    });
  });

  it('[UC-AP-02] refuses an appearance the site cannot use, says which part, and stores nothing', async () => {
    const { admin, siteId } = world.orchard;
    await save(admin.headers, { theme: HARBOUR }).expect(200);
    const before = await storedSite(siteId);

    const withPalette = (palette: object) => ({
      theme: { ...HARBOUR, palette: { ...HARBOUR.palette, ...palette } },
    });
    const refused: [object, string][] = [
      [{}, 'body'],
      [{ name: '' }, 'name'],
      [{ name: 'x'.repeat(121) }, 'name'],
      [{ tagline: 'x'.repeat(121) }, 'tagline'],
      [{ footerNote: 'x'.repeat(301) }, 'footerNote'],
      [{ siteId: world.maple.siteId }, 'siteId'],
      [{ theme: { ...HARBOUR, typeSet: 'comic' } }, 'theme.typeSet'],
      [{ theme: { ...HARBOUR, shape: 'round' } }, 'theme.shape'],
      [{ theme: { ...HARBOUR, density: 'airy' } }, 'theme.density'],
      [{ theme: { ...HARBOUR, texture: 'marble' } }, 'theme.texture'],
      [{ theme: { ...HARBOUR, font: 'Comic Sans' } }, 'theme'],
      [
        withPalette({ brand: 'red; background: url(https://evil.example)' }),
        'theme.palette.brand',
      ],
      [withPalette({ ink: 'var(--other)' }), 'theme.palette.ink'],
      [withPalette({ glow: '#ffffff' }), 'theme.palette'],
      [
        { theme: { ...HARBOUR, palette: { paper: '#ffffff' } } },
        'theme.palette',
      ],
    ];
    for (const [body, field] of refused) {
      const refusal = await save(admin.headers, body);
      expect(refusal.status, JSON.stringify(body)).toBe(400);
      expect(refusal.body.errors.join(' '), JSON.stringify(body)).toContain(
        field,
      );
    }
    expect(await storedSite(siteId)).toEqual(before);
  });

  it('[UC-AP-03] only settings.manage may save; every member may read; each site changes only itself', async () => {
    const { admin, editor, viewer, siteId } = world.orchard;
    const mapleBefore = await storedSite(world.maple.siteId);

    await save(editor.headers, { name: 'Taken over' }).expect(403);
    await save(viewer.headers, { tagline: 'Hello' }).expect(403);
    await read(editor.headers).expect(200);
    expect((await storedSite(siteId)).name).toBe('Orchard Bakery');

    // Orchard's administrator names Maple's site in the header: not a member there.
    await save(
      { ...admin.headers, 'X-Site-Id': world.maple.siteId },
      { name: 'Taken over' },
    ).expect(403);
    await world.api().patch('/appearance').send({ name: 'No one' }).expect(401);

    await save(world.maple.admin.headers, {
      tagline: 'Books worth keeping',
    }).expect(200);
    expect((await storedSite(world.maple.siteId)).settings).toEqual({
      ...mapleBefore.settings,
      tagline: 'Books worth keeping',
    });
    expect((await storedSite(siteId)).settings).toEqual({});
  });

  it('[UC-AP-04] a save shows on the website at once: the address lookup forgets the site and the website is told', async () => {
    const { admin } = world.orchard;
    const home = await world.newPage(admin, 'home', { title: 'Home' });
    await world
      .api()
      .post(`/content/${home.id}/publish`)
      .set(admin.headers)
      .expect(200);
    // Seen once, so the site's address lookup is remembered.
    const first = await world
      .api()
      .get('/public/site?host=orchard.test&path=/')
      .expect(200);
    expect(first.body.site.name).toBe('Orchard Bakery');
    told = [];

    await save(admin.headers, { name: 'Orchard & Co' }).expect(200);
    const next = await world
      .api()
      .get('/public/site?host=orchard.test&path=/')
      .expect(200);
    expect(next.body.site.name).toBe('Orchard & Co');
    expect(told).toEqual([
      { path: '/api/revalidate', body: { hosts: ['orchard.test'] } },
    ]);

    // A refused save tells nobody.
    told = [];
    await save(admin.headers, { name: '' }).expect(400);
    expect(told).toEqual([]);
  });
});
