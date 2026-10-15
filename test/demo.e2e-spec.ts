import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { AppearanceService } from '../src/appearance/appearance.service.js';
import { runDemo, type DemoApp } from '../src/cli/run-demo.js';
import { ContentTypesService } from '../src/content/content-types.service.js';
import { ContentRepository } from '../src/content/content.repository.js';
import { ContentService } from '../src/content/content.service.js';
import { MediaService } from '../src/media/media.service.js';
import { PlatformRepository } from '../src/platform/platform.repository.js';
import { ProvisioningService } from '../src/provisioning/provisioning.service.js';
import { SiteRemovalService } from '../src/site-removal/site-removal.service.js';
import { createTestApp } from './support/app.js';
import { resetDatabase } from './support/database.js';

/**
 * The demo command (DEP-03 minimum, D-044) end to end: the real `runDemo` with the real demo files in
 * `demo/`, the real services, the test database and the tests' own picture folder. The command is
 * given this file's application (its `close` does nothing), as run-seed.e2e-spec.ts does: a second
 * Nest application in the same test process sometimes left this one's database connection closed.
 * What it made is then read the way the website and the admin read it: through the public route, the
 * sign-in and the uploaded files.
 */

// Two clients: 18 pictures through sharp, two sites, 17 pages and items.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

const PASSWORD = 'demo-owner-password-123';
let app: INestApplication;
let dataSource: DataSource;

const api = () => request(app.getHttpServer());
const lines = () => {
  const io = { output: [] as string[], errors: [] as string[] };
  return {
    io,
    sink: {
      out: (line: string) => io.output.push(line),
      err: (line: string) => io.errors.push(line),
    },
  };
};
const thisApp = async (): Promise<DemoApp> => ({
  provisioning: app.get(ProvisioningService),
  platform: app.get(PlatformRepository),
  removal: app.get(SiteRemovalService),
  media: app.get(MediaService),
  appearance: app.get(AppearanceService),
  types: app.get(ContentTypesService),
  content: app.get(ContentService),
  pages: app.get(ContentRepository),
  close: async () => {},
});
const demo = (argv: string[]) => {
  const { io, sink } = lines();
  return runDemo(argv, { SEED_ADMIN_PASSWORD: PASSWORD }, sink, thisApp).then(
    (code) => ({ code, ...io }),
  );
};

beforeAll(async () => {
  ({ app, dataSource } = await createTestApp());
  await resetDatabase(dataSource);
});

afterAll(async () => {
  await app.close();
});

const site = (host: string, path = '/') =>
  api().get(`/public/site?host=${host}&path=${encodeURIComponent(path)}`);

describe('npm run demo', () => {
  it('[UC-DM-01] makes both clients from the demo files: addresses, pictures, logo, look, a content type each and their pages, all published and owned by one account', async () => {
    const run = await demo([
      '--email',
      'Owner@Demo.test',
      '--name',
      'Demo Owner',
      '--domain',
      'demo.test',
    ]);
    expect(run.errors).toEqual([]);
    expect(run.code).toBe(0);
    expect(run.output.join('\n')).toMatch(
      /Kettle & Crumb at kettle-and-crumb\.demo\.test: 9 pictures, 1 content type, 9 pages/,
    );
    expect(run.output.join('\n')).toMatch(
      /Studio Halden at studio-halden\.demo\.test: 9 pictures, 1 content type, 9 pages/,
    );

    // One sign-in lists both, as their organisations' owner.
    const login = await api()
      .post('/auth/login')
      .send({ email: 'owner@demo.test', password: PASSWORD })
      .expect(200);
    expect(
      login.body.memberships.map(
        (m: {
          site: { name: string; primaryHost: string };
          ownsOrganization: boolean;
        }) => [m.site.name, m.site.primaryHost, m.ownsOrganization],
      ),
    ).toEqual([
      ['Kettle & Crumb', 'kettle-and-crumb.demo.test', true],
      ['Studio Halden', 'studio-halden.demo.test', true],
    ]);

    // The bakery's front page: its own blocks, its logo and look, and pictures that really load.
    const home = await site('kettle-and-crumb.demo.test').expect(200);
    expect(home.body.page.title).toBe('Home');
    const hero = home.body.page.blocks[0];
    expect(hero).toMatchObject({
      type: 'hero',
      headline: 'Bread worth getting up early for',
    });
    expect(hero.image.src).toMatch(
      /^http:\/\/media\.test\/uploads\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.jpg$/,
    );
    expect(home.body.site.settings).toMatchObject({
      tagline: 'Bakery & café · since 2009',
      logoUrl: expect.stringMatching(/\.png$/),
    });
    expect(home.body.site.theme).toMatchObject({
      typeSet: 'editorial',
      texture: 'grain',
    });
    const picture = await api()
      .get(new URL(hero.image.src).pathname)
      .buffer(true)
      .expect(200);
    expect(picture.headers['content-type']).toBe('image/jpeg');
    expect(
      home.body.navigation.map((link: { title: string }) => link.title),
    ).toEqual(['Our story', 'Visit us', 'Posts', 'Recipes']);

    // Its content type: the list and an item.
    const recipes = await site('kettle-and-crumb.demo.test', '/recipes').expect(
      200,
    );
    expect(recipes.body.listing).toMatchObject({ title: 'Recipes', total: 3 });
    const rye = await site(
      'kettle-and-crumb.demo.test',
      '/recipes/seeded-rye-at-home',
    ).expect(200);
    expect(
      rye.body.page.blocks.map((block: { type: string }) => block.type),
    ).toEqual(['hero', 'richText', 'richText']);

    // The studio: its own look, its projects, and nothing of the bakery's.
    const studio = await site('studio-halden.demo.test').expect(200);
    expect(studio.body.site.theme).toMatchObject({
      typeSet: 'technical',
      shape: 'sharp',
      texture: 'grid',
    });
    expect(
      (await site('studio-halden.demo.test', '/projects').expect(200)).body
        .listing.total,
    ).toBe(4);
    await site('studio-halden.demo.test', '/recipes').expect(404);
    await site('kettle-and-crumb.demo.test', '/projects').expect(404);
  });

  it('[UC-DM-02] run again, it refuses to make a client twice; with --replace it deletes and remakes them, pictures and all', async () => {
    const again = await demo([
      '--email',
      'owner@demo.test',
      '--domain',
      'demo.test',
    ]);
    expect(again.code).toBe(1);
    expect(again.errors.join('\n')).toMatch(
      /kettle-and-crumb\.demo\.test is already a site \(Kettle & Crumb\)\. Run again with --replace/,
    );

    const before = (await site('kettle-and-crumb.demo.test').expect(200)).body
      .page.blocks[0].image.src;
    const replaced = await demo([
      '--email',
      'owner@demo.test',
      '--domain',
      'demo.test',
      '--replace',
    ]);
    expect(replaced.errors).toEqual([]);
    expect(replaced.code).toBe(0);
    const after = (await site('kettle-and-crumb.demo.test').expect(200)).body
      .page.blocks[0].image.src;
    expect(after).not.toBe(before);
    // The old site's pictures went with it.
    await api().get(new URL(before).pathname).expect(404);
    const [{ n }] = await dataSource.query(
      `SELECT count(*)::int AS n FROM sites`,
    );
    expect(n).toBe(2);
  });

  it('[UC-DM-02] a missing account or a bad domain is refused before anything is made', async () => {
    expect((await demo(['--domain', 'demo.test'])).errors[0]).toMatch(
      /--email/,
    );
    expect(
      (await demo(['--email', 'a@b.test', '--domain', 'not a domain']))
        .errors[0],
    ).toMatch(/--domain/);
    expect(
      (await demo(['--email', 'a@b.test', '--colour', 'red'])).errors[0],
    ).toMatch(/Unknown option --colour/);
  });
});
