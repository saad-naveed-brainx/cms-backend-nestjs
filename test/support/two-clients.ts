import type { INestApplication } from '@nestjs/common';
import sharp from 'sharp';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { createTestApp } from './app.js';
import { resetDatabase } from './database.js';
import { invite, newClient, roleIdOf, type Client } from './invitations.js';
import { addMember } from './members.js';
import { TEST_PASSWORD, seedMembership, seedUser } from './seed.js';

/**
 * Two clients, Acorn (A) and Birch (B), for the tenant isolation tests, made through the real
 * routes with real sign-ins and nothing mocked. They are made to **share** what a leak could hide
 * behind: the same page address `/about`, the same draft address, the same content type address
 * `/recipes`, and one person who belongs to both. Everything that should stay apart carries its
 * side's tag (`acorn` or `birch`) in its name, title, email or address, so a response that
 * mentions the other side's tag has leaked.
 */

type Headers = { Authorization: string; 'X-Site-Id': string };

/** Everything one side owns, as ids and names a request can be aimed at. */
export type Side = {
  /** `acorn` or `birch`: appears in every name, title, email and address of this side. */
  tag: string;
  /** The address the side answers on: `<tag>.test`. */
  host: string;
  /** The side's administrator and organisation owner, signed in. */
  owner: Client;
  organizationId: string;
  siteId: string;
  /** A published page at `/about`. */
  aboutId: string;
  /** A draft page at `/draft`. */
  draftId: string;
  /** The content type "Recipe" at `/recipes`, and an item of it at `/recipes/soup`. */
  typeId: string;
  soupId: string;
  mediaId: string;
  /** The stored file name of the side's picture (the last part of its address). */
  mediaName: string;
  /** A member with the Author role, and the site's Author role. */
  memberId: string;
  roleId: string;
  /** A waiting invitation, its secret link, and the email it is for. */
  invitationId: string;
  invitationToken: string;
  invitationEmail: string;
  /** A preview link for the draft page. */
  previewToken: string;
};

export type World = {
  app: INestApplication;
  dataSource: DataSource;
  api: () => ReturnType<typeof request>;
  A: Side;
  B: Side;
  /** One person who belongs to both sides: an Editor on A and an Author on B. */
  pat: {
    userId: string;
    email: string;
    token: string;
    headersA: Headers;
    headersB: Headers;
  };
  /** A small real picture, for uploads. */
  picture: Buffer;
  close: () => Promise<void>;
};

const capital = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/** A real PNG, small enough to upload many times. */
export const makePicture = () =>
  sharp({
    create: {
      width: 8,
      height: 8,
      channels: 3,
      background: { r: 200, g: 120, b: 40 },
    },
  })
    .png()
    .toBuffer();

export async function buildWorld(): Promise<World> {
  const { app, dataSource } = await createTestApp();
  // Listening on a loopback port keeps supertest from opening and closing a listener per call.
  await app.listen(0, '127.0.0.1');
  await resetDatabase(dataSource);
  const api = () => request(app.getHttpServer());
  const picture = await makePicture();

  /** The answer's body, or a failed test that says which step went wrong. */
  async function must(
    pending: PromiseLike<{ status: number; body: any }>,
    status: number,
    what: string,
  ) {
    const res = await pending;
    if (res.status !== status) {
      throw new Error(
        `world: ${what}: expected ${status}, got ${res.status} ${JSON.stringify(res.body)}`,
      );
    }
    return res.body;
  }

  async function makeSide(
    tag: string,
    siteName: string,
    adminName: string,
  ): Promise<Side> {
    const Tag = capital(tag);
    const owner = await newClient(app, { prefix: tag, adminName, siteName });
    const h = owner.headers;

    const orgs = await must(
      api().get('/organizations').set({ Authorization: h.Authorization }),
      200,
      'organisations',
    );

    const about = await must(
      api()
        .post('/content')
        .set(h)
        .send({
          type: 'page',
          title: `${Tag} About`,
          slug: 'about',
          blocks: [{ type: 'hero', headline: `${Tag} headline` }],
        }),
      201,
      'about page',
    );
    await must(
      api().post(`/content/${about.id}/publish`).set(h),
      200,
      'publish about',
    );
    const draft = await must(
      api()
        .post('/content')
        .set(h)
        .send({ type: 'page', title: `${Tag} Draft`, slug: 'draft' }),
      201,
      'draft page',
    );

    const type = await must(
      api()
        .post('/content-types')
        .set(h)
        .send({ name: 'Recipe', urlPrefix: '/recipes' }),
      201,
      'content type',
    );
    const soup = await must(
      api()
        .post('/content')
        .set(h)
        .send({ type: 'recipe', title: `${Tag} Soup`, slug: 'soup' }),
      201,
      'recipe item',
    );
    await must(
      api().post(`/content/${soup.id}/publish`).set(h),
      200,
      'publish recipe item',
    );

    const media = await must(
      api().post('/media').set(h).attach('file', picture, `${tag}.png`),
      201,
      'picture',
    );

    // The stored file name is the last part of the picture's address. Checked here, so a change in
    // what the media route answers fails at setup and not inside an unrelated expectation later.
    const mediaName = String(media.url ?? '')
      .split('/')
      .pop();
    if (!mediaName) {
      throw new Error(
        `world: the media route answered with no usable url: ${JSON.stringify(media)}`,
      );
    }

    const writer = await addMember(app, owner.siteId, {
      email: `writer@${tag}.test`,
      name: `${Tag} Writer`,
      role: 'Author',
    });
    const roleId = await roleIdOf(app, owner.siteId, 'Author');
    const invited = await invite(app, owner, `newbie@${tag}.test`, 'Author');

    await must(
      api()
        .patch('/appearance')
        .set(h)
        .send({ tagline: `${Tag} tagline` }),
      200,
      'appearance',
    );
    const link = await must(
      api().post(`/content/${draft.id}/preview`).set(h),
      200,
      'preview link',
    );

    return {
      tag,
      host: `${tag}.test`,
      owner,
      organizationId: orgs.items[0].id,
      siteId: owner.siteId,
      aboutId: about.id,
      draftId: draft.id,
      typeId: type.id,
      soupId: soup.id,
      mediaId: media.id,
      mediaName,
      memberId: writer.userId,
      roleId,
      invitationId: invited.id,
      invitationToken: invited.token,
      invitationEmail: `newbie@${tag}.test`,
      previewToken: link.token,
    };
  }

  const A = await makeSide('acorn', 'Acorn Bakery', 'Ada Acorn');
  const B = await makeSide('birch', 'Birch Books', 'Bea Birch');

  // One person in both sites, with a different role in each.
  const patUser = await seedUser(dataSource, {
    email: 'pat@both.test',
    name: 'Pat Both',
    password: TEST_PASSWORD,
  });
  await seedMembership(dataSource, {
    siteId: A.siteId,
    userId: patUser.id,
    roleId: await roleIdOf(app, A.siteId, 'Editor'),
  });
  await seedMembership(dataSource, {
    siteId: B.siteId,
    userId: patUser.id,
    roleId: await roleIdOf(app, B.siteId, 'Author'),
  });
  const login = await must(
    api()
      .post('/auth/login')
      .send({ email: 'pat@both.test', password: TEST_PASSWORD }),
    200,
    'Pat signs in',
  );
  const bearer = `Bearer ${login.accessToken}`;

  return {
    app,
    dataSource,
    api,
    A,
    B,
    pat: {
      userId: patUser.id,
      email: 'pat@both.test',
      token: login.accessToken,
      headersA: { Authorization: bearer, 'X-Site-Id': A.siteId },
      headersB: { Authorization: bearer, 'X-Site-Id': B.siteId },
    },
    picture,
    close: () => app.close(),
  };
}

/** The tables that hold a tenant's rows: every table with a `site_id` column, found from the database itself. */
export async function tenantTables(dataSource: DataSource): Promise<string[]> {
  const rows = await dataSource.query<{ table_name: string }[]>(
    `SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'site_id'
      ORDER BY table_name`,
  );
  return rows.map((row) => row.table_name);
}

/**
 * A fingerprint of one site: for every tenant table, how many of its rows there are and a hash of
 * their whole content (every column), plus the hash of the site's own row. Two fingerprints are equal
 * only if nothing about the site changed. The tables are found from the database, so one added later
 * is included without anyone remembering.
 */
export async function fingerprint(
  dataSource: DataSource,
  siteId: string,
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const table of await tenantTables(dataSource)) {
    const [row] = await dataSource.query<{ n: number; h: string }[]>(
      `SELECT count(*)::int AS n, md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS h
         FROM "${table}" t WHERE t.site_id = $1`,
      [siteId],
    );
    result[table] = `${row.n} rows, ${row.h}`;
  }
  const [site] = await dataSource.query<{ h: string }[]>(
    'SELECT md5(t::text) AS h FROM sites t WHERE t.id = $1',
    [siteId],
  );
  result.sites = site ? site.h : 'gone';
  return result;
}

/**
 * The id of every row a site owns, in every tenant table that has an `id` column, plus the ids of
 * the people who are members of it, for finding them in an answer.
 */
export async function ownedIds(
  dataSource: DataSource,
  siteId: string,
): Promise<string[]> {
  const ids = new Set<string>([siteId]);
  const withId = await dataSource.query<{ table_name: string }[]>(
    `SELECT c.table_name FROM information_schema.columns c
      WHERE c.table_schema = 'public' AND c.column_name = 'site_id'
        AND EXISTS (SELECT 1 FROM information_schema.columns d
                     WHERE d.table_schema = 'public' AND d.table_name = c.table_name AND d.column_name = 'id')`,
  );
  for (const { table_name: table } of withId) {
    const rows = await dataSource.query<{ id: string }[]>(
      `SELECT id::text AS id FROM "${table}" WHERE site_id = $1`,
      [siteId],
    );
    rows.forEach((row) => ids.add(row.id));
  }
  const members = await dataSource.query<{ id: string }[]>(
    'SELECT user_id::text AS id FROM site_members WHERE site_id = $1',
    [siteId],
  );
  members.forEach((row) => ids.add(row.id));
  return [...ids];
}
