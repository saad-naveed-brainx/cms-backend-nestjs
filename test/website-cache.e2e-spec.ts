import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  buildContentWorld,
  type ContentWorld,
} from './support/content-world.js';
import { seedHostname } from './support/seed.js';

/**
 * Telling the public website to forget a site (CNT-08, D-032), through the real content routes. A
 * small stand-in for the website records what it is told; the API is pointed at it with
 * `WEB_REVALIDATE_URL` and `REVALIDATE_SECRET`, as in production.
 */

// Making the clients hashes with production-cost scrypt (about 0.2 s each).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const SECRET = 'test-revalidate-secret';

type Told = {
  method: string;
  path: string;
  authorization: string | undefined;
  body: unknown;
};

let world: ContentWorld;
let website: Server;
let told: Told[] = [];
/** What the stand-in answers with: 200, or a failure. */
let answer = 200;

beforeAll(async () => {
  website = createServer((request, response) => {
    let data = '';
    request.on('data', (chunk) => (data += chunk));
    request.on('end', () => {
      told.push({
        method: request.method ?? '',
        path: request.url ?? '',
        authorization: request.headers.authorization,
        body: data ? JSON.parse(data) : null,
      });
      response.writeHead(answer, { 'content-type': 'application/json' });
      response.end('{}');
    });
  });
  await new Promise<void>((resolve) => website.listen(0, '127.0.0.1', resolve));
  const { port } = website.address() as AddressInfo;
  process.env.WEB_REVALIDATE_URL = `http://127.0.0.1:${port}/api/revalidate`;
  process.env.REVALIDATE_SECRET = SECRET;

  world = await buildContentWorld();
  // Orchard answers on a second address too: the website must forget both.
  await seedHostname(
    world.dataSource,
    world.orchard.siteId,
    'www.orchard.test',
  );
});

beforeEach(async () => {
  await world.dataSource.query('DELETE FROM content');
  told = [];
  answer = 200;
});

afterAll(async () => {
  process.env.WEB_REVALIDATE_URL = '';
  delete process.env.REVALIDATE_SECRET;
  await world.close();
  await new Promise<void>((resolve) => website.close(() => resolve()));
});

const api = () => world.api();

describe('telling the website to forget a site', () => {
  it('[UC-CC-01] publishing tells the website to forget the site at every address it has, with the secret', async () => {
    const { admin } = world.orchard;
    const page = await world.newPage(admin, 'about');
    // A draft is not public: nothing to forget.
    expect(told).toEqual([]);

    await api()
      .post(`/content/${page.id}/publish`)
      .set(admin.headers)
      .expect(200);
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({
      method: 'POST',
      path: '/api/revalidate',
      authorization: `Bearer ${SECRET}`,
    });
    expect((told[0].body as { hosts: string[] }).hosts.sort()).toEqual([
      'orchard.test',
      'www.orchard.test',
    ]);
    // Never another site's address.
    expect(JSON.stringify(told)).not.toContain('maple.test');
  });

  it('[UC-CC-02] changing a live page and unpublishing it tell the website too; changing a draft does not', async () => {
    const { admin } = world.orchard;
    const draft = await world.newPage(admin, 'plans');
    await api()
      .patch(`/content/${draft.id}`)
      .set(admin.headers)
      .send({ title: 'Plans, again' })
      .expect(200);
    expect(told).toEqual([]);

    const live = await world.newPage(admin, 'about');
    await api()
      .post(`/content/${live.id}/publish`)
      .set(admin.headers)
      .expect(200);
    await api()
      .patch(`/content/${live.id}`)
      .set(admin.headers)
      .send({ title: 'About us' })
      .expect(200);
    await api()
      .post(`/content/${live.id}/unpublish`)
      .set(admin.headers)
      .expect(200);
    expect(told).toHaveLength(3);
  });

  it('[UC-CC-03] a website that refuses or cannot be reached never stops a publish', async () => {
    const { admin } = world.orchard;
    answer = 500;
    const first = await world.newPage(admin, 'first');
    const published = await api()
      .post(`/content/${first.id}/publish`)
      .set(admin.headers)
      .expect(200);
    expect(published.body.status).toBe('published');
    expect(told).toHaveLength(1);

    // Nothing listens on port 9 (discard): the call fails at once and the publish still goes through.
    const saved = process.env.WEB_REVALIDATE_URL;
    process.env.WEB_REVALIDATE_URL = 'http://127.0.0.1:9/api/revalidate';
    try {
      const second = await world.newPage(admin, 'second');
      await api()
        .post(`/content/${second.id}/publish`)
        .set(admin.headers)
        .expect(200);
    } finally {
      process.env.WEB_REVALIDATE_URL = saved;
    }
  });
});
