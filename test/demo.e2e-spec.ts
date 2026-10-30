import type {
  INestApplication,
  INestApplicationContext,
  Type,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { PasswordService } from '../src/auth/password.service.js';
import { runDemo } from '../src/cli/run-demo.js';
import { ProvisioningService } from '../src/provisioning/provisioning.service.js';
import { createTestApp } from './support/app.js';
import { resetDatabase } from './support/database.js';

/**
 * The demo command (DEP-03 minimum, D-044) end to end: the real `runDemo` with the real demo files in
 * `demo/`, the real services, the test database and the tests' own picture folder. When the command
 * opens its application it is handed this file's (whose `close` does nothing), so it finds whichever
 * services it asks for, as run-seed.e2e-spec.ts does: a second Nest application in the same test
 * process sometimes left this one's database connection closed.
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
const thisApp = {
  get: (service: Type) => app.get(service),
  close: async () => {},
} as unknown as INestApplicationContext;
const demo = (argv: string[]) => {
  const { io, sink } = lines();
  return runDemo(argv, { SEED_ADMIN_PASSWORD: PASSWORD }, sink).then(
    (code) => ({ code, ...io }),
  );
};

/** What the people tests need of each folder in `demo/`, read from the files the command reads. */
type DemoClient = {
  address: string;
  people: { name: string; email: string; role: string }[];
  items: { type: string; slug: string; author?: string }[];
};
const demoClients = (): DemoClient[] => {
  const root = resolve('demo');
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const client = JSON.parse(
        readFileSync(join(root, entry.name, 'content.json'), 'utf8'),
      ) as DemoClient;
      return { ...client, people: client.people ?? [] };
    });
};

beforeAll(async () => {
  ({ app, dataSource } = await createTestApp());
  await resetDatabase(dataSource);
  vi.spyOn(NestFactory, 'createApplicationContext').mockResolvedValue(thisApp);
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

  it('[UC-UR-27] puts an Editor, an Author, a Contributor and a Viewer on each demo site, credits their pages and prints new passwords once; --replace brings them back on the same accounts', async () => {
    // From nothing: an account left by an earlier run would not be a new person here.
    await resetDatabase(dataSource);
    const owner = 'owner@people.test';
    const domain = 'people.test';
    const run = ['--email', owner, '--name', 'Demo Owner', '--domain', domain];
    const clients = demoClients();
    const everyone = clients.flatMap((client) => client.people);
    const accounts = () =>
      dataSource.query<{ id: string; email: string; password_hash: string }[]>(
        `SELECT id, email, password_hash FROM users ORDER BY email`,
      );

    // Read as the admin reads it: the owner's sites, each site's members and its pages.
    const expectPeopleAndAuthors = async () => {
      const { accessToken, memberships } = (
        await api()
          .post('/auth/login')
          .send({ email: owner, password: PASSWORD })
          .expect(200)
      ).body;
      for (const client of clients) {
        const host = `${client.address}.${domain}`;
        const siteId = memberships.find(
          (m: { site: { primaryHost: string } }) => m.site.primaryHost === host,
        )?.site.id;
        expect(siteId, `the owner's site at ${host}`).toBeDefined();
        const headers = {
          Authorization: `Bearer ${accessToken}`,
          'X-Site-Id': siteId,
        };
        const { members } = (
          await api().get('/members').set(headers).expect(200)
        ).body;
        const { items: pages } = (
          await api().get('/content?limit=100').set(headers).expect(200)
        ).body;

        // The demo folder lists the four, and credits some pages.
        expect(
          client.people.map(({ role }) => role).sort(),
          `${client.address}'s people in content.json`,
        ).toEqual(['Author', 'Contributor', 'Editor', 'Viewer']);
        expect(
          client.items.filter(({ author }) => author),
          `${client.address}'s credited pages in content.json`,
        ).not.toEqual([]);

        const byEmail = (a: { email: string }, b: { email: string }) =>
          a.email.localeCompare(b.email);
        expect(
          members
            .filter((member: { isOwner: boolean }) => !member.isOwner)
            .map(
              (member: {
                name: string;
                email: string;
                role: { name: string };
              }) => ({
                name: member.name,
                email: member.email,
                role: member.role.name,
              }),
            )
            .sort(byEmail),
          `${host}'s members`,
        ).toEqual([...client.people].sort(byEmail));

        // Created and published as that person; a page crediting no one stays the owner's.
        for (const { type, slug, author = owner } of client.items) {
          const writer = members.find(
            (member: { email: string }) => member.email === author,
          );
          expect(
            pages.find(
              (page: { type: { slug: string }; slug: string }) =>
                page.type.slug === type && page.slug === slug,
            ),
            `${host} ${type} ${slug}`,
          ).toMatchObject({
            status: 'published',
            updatedBy: writer?.userId,
            author: { id: writer?.userId, name: writer?.name },
          });
        }
      }
    };

    const first = await demo(run);
    expect(first.errors).toEqual([]);
    expect(first.code).toBe(0);
    await expectPeopleAndAuthors();

    // One account each, and the owner's.
    const before = await accounts();
    expect(before).toHaveLength(
      new Set(everyone.map(({ email }) => email)).size + 1,
    );

    // Each new password is the 24-character word that opens that person's stored hash, printed once.
    const passwords = new PasswordService();
    const printed = first.output.join('\n');
    const words = new Set(
      printed.split(/[^A-Za-z0-9_-]+/).filter((word) => word.length === 24),
    );
    const passwordOf = new Map<string, string>();
    for (const { email } of everyone) {
      const hash = before.find((one) => one.email === email)!.password_hash;
      for (const word of words) {
        if (await passwords.verify(word, hash)) passwordOf.set(email, word);
      }
      const password = passwordOf.get(email);
      expect(password, `${email}'s password in the output`).toBeDefined();
      expect(printed.split(password!), `${email}'s password`).toHaveLength(2);
    }

    const second = await demo([...run, '--replace']);
    expect(second.errors).toEqual([]);
    expect(second.code).toBe(0);
    const said = second.output.join('\n');
    expect(
      said.match(/existing account, password unchanged/gi) ?? [],
    ).toHaveLength(everyone.length);
    await expectPeopleAndAuthors();

    // The same accounts, none added, and the passwords they were given still sign them in.
    expect(await accounts()).toEqual(before);
    for (const [email, password] of passwordOf) {
      expect(said).not.toContain(password);
      await api().post('/auth/login').send({ email, password }).expect(200);
    }
  });

  it('[UC-UR-27] a bad file is refused before anything is made or deleted, even with --replace', async () => {
    const owner = 'owner@refused.test';
    const domain = 'refused.test';
    const address = 'bad-client';
    // A site at the address the bad files name, so `--replace` would delete it if it got that far.
    await app.get(ProvisioningService).provisionTenant({
      organizationName: 'Bad Client Ltd',
      siteName: 'Bad Client',
      hostnames: [`${address}.${domain}`],
      admin: { email: owner, name: 'Owner' },
    });

    const folder = mkdtempSync(join(tmpdir(), 'demo-refused-'));
    onTestFinished(() => rmSync(folder, { recursive: true, force: true }));
    mkdirSync(join(folder, 'client'));
    const everyRow = () =>
      dataSource.query(
        `SELECT (SELECT array_agg(id ORDER BY id) FROM sites) AS sites,
                (SELECT array_agg(id ORDER BY id) FROM users) AS users,
                (SELECT count(*)::int FROM invitations) AS invitations`,
      );
    const refused = async (file: DemoClient, email: string) => {
      writeFileSync(
        join(folder, 'client', 'content.json'),
        JSON.stringify({ ...file, address }),
      );
      const before = await everyRow();
      const run = await demo([
        '--email',
        email,
        '--domain',
        domain,
        '--replace',
        '--from',
        folder,
      ]);
      expect(run.code).toBe(1);
      expect(await everyRow()).toEqual(before);
      return run.errors.join('\n');
    };

    const [client] = demoClients();
    const page = client.items.findIndex(({ author }) => author);
    expect(
      await refused(
        {
          ...client,
          items: client.items.with(page, {
            ...client.items[page],
            author: 'nobody@refused.test',
          }),
        },
        owner,
      ),
    ).toMatch(/nobody@refused\.test is not in people/);

    // The clash from any spelling of the address: the account's is the stored, lower-case one.
    expect(
      await refused(
        {
          ...client,
          people: [
            ...client.people,
            { name: 'Owner', email: owner, role: 'Viewer' },
          ],
        },
        'Owner@Refused.test',
      ),
    ).toMatch(/owner@refused\.test owns the demo sites.*Use another --email/);
  });
});
