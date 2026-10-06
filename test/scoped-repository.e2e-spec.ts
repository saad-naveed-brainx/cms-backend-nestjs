import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { QueryFailedError, type DataSource } from 'typeorm';
import { validate as isUuid, version as uuidVersion } from 'uuid';
import { ContentTypeRepository } from '../src/content-types/content-type.repository.js';
import { ContentRepository } from '../src/content/content.repository.js';
import { ContentStatus } from '../src/database/entities/content.entity.js';
import { Content, ContentType, Site } from '../src/database/entities/index.js';
import { createTestApp } from './support/app.js';
import { resetDatabase } from './support/database.js';
import {
  seedContentType,
  seedPage,
  seedTrashedPage,
  seedTwoSites,
  type PageSeed,
  type TwoSites,
} from './support/seed.js';

/**
 * The site-scoped desks (FND-02): every read and write names a site, and nothing ever crosses
 * into another site's rows. Both seeded sites, Corrick and Bakery, hold data in these tests, so a
 * query that lost its site condition would visibly return or change the other site's rows.
 *
 * Rows a test reads are seeded straight into the tables (test/support/seed.ts), past the desks,
 * so a read test does not depend on the desk's own writes. Rows that must stay untouched get an
 * `updatedAt` far in the past, so any write to them shows.
 */

/** Long enough ago that any write to a row visibly moves its `updatedAt`. */
const LONG_AGO = new Date('2026-01-01T00:00:00.000Z');

const ids = (rows: { id: string }[]) => rows.map((row) => row.id);
const sortedIds = (rows: { id: string }[]) => ids(rows).sort();

/** The Postgres constraint a refused write broke, read as test/tenancy.e2e-spec.ts does. */
function constraintOf(error: unknown): string | undefined {
  expect(error).toBeInstanceOf(QueryFailedError);
  return (error as QueryFailedError<Error & { constraint?: string }>)
    .driverError.constraint;
}

describe('site-scoped desks for pages and page types', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let pages: ContentRepository;
  let pageTypes: ContentTypeRepository;
  let data: TwoSites;
  let corrick: string;
  let bakery: string;

  beforeAll(async () => {
    ({ app, dataSource } = await createTestApp());
    pages = app.get(ContentRepository);
    pageTypes = app.get(ContentTypeRepository);
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
    data = await seedTwoSites(dataSource);
    corrick = data.corrick.site.id;
    bakery = data.bakery.site.id;
  });

  afterAll(async () => {
    await app.close();
  });

  /** A page exactly as stored, trashed or not, read past the desk. */
  const storedPage = (id: string) =>
    dataSource.manager.findOneOrFail(Content, {
      where: { id },
      withDeleted: true,
    });

  /** Every page a site has, trashed ones included, counted past the desk. */
  const countPages = (siteId: string) =>
    dataSource.manager.count(Content, { where: { siteId }, withDeleted: true });

  /** Every page and page type, trashed pages included, read past the desks. */
  const everyRow = async () => ({
    pages: await dataSource.manager.find(Content, {
      withDeleted: true,
      order: { id: 'ASC' },
    }),
    pageTypes: await dataSource.manager.find(ContentType, {
      order: { id: 'ASC' },
    }),
  });

  /**
   * Checks a call was refused up front: it fails with the expected clear error (not a database
   * error), returns nothing, sends no SQL at all, and leaves every stored row exactly as it was.
   * The rows are read before the SQL spy goes in and after it comes out, so only the call's own
   * queries are counted.
   */
  async function expectRefusedBeforeAnyQuery(
    call: () => Promise<unknown>,
    message: RegExp,
  ): Promise<void> {
    const rowsBefore = await everyRow();
    const logQuery = vi.spyOn(dataSource.logger, 'logQuery');

    const outcome = await call().then(
      (resolvedWith: unknown) => ({ resolvedWith }),
      (error: unknown) => ({ error }),
    );
    const sqlSent = logQuery.mock.calls.map(([sql]) => sql);
    logQuery.mockRestore();

    // On failure this shows what the call returned instead, e.g. rows from both sites.
    expect(outcome).toEqual({ error: expect.any(Error) });
    const { error } = outcome as { error: Error };
    expect(error.message).toMatch(message);
    expect(error).not.toBeInstanceOf(QueryFailedError);
    expect(sqlSent).toEqual([]);
    expect(await everyRow()).toEqual(rowsBefore);
  }

  describe('pages desk', () => {
    let corrickType: ContentType;
    let bakeryType: ContentType;

    type PageFields = Omit<PageSeed, 'siteId' | 'contentTypeId'>;
    const corrickPage = (fields: PageFields) =>
      seedPage(dataSource, {
        siteId: corrick,
        contentTypeId: corrickType.id,
        ...fields,
      });
    const bakeryPage = (fields: PageFields) =>
      seedPage(dataSource, {
        siteId: bakery,
        contentTypeId: bakeryType.id,
        ...fields,
      });
    const corrickTrashedPage = (fields: PageFields) =>
      seedTrashedPage(dataSource, {
        siteId: corrick,
        contentTypeId: corrickType.id,
        ...fields,
      });
    const bakeryTrashedPage = (fields: PageFields) =>
      seedTrashedPage(dataSource, {
        siteId: bakery,
        contentTypeId: bakeryType.id,
        ...fields,
      });

    beforeEach(async () => {
      corrickType = await seedContentType(dataSource, { siteId: corrick });
      bakeryType = await seedContentType(dataSource, { siteId: bakery });
    });

    it('[UC-SR-01] reads one of my pages by id, with its title, slug, path, status, blocks and data', async () => {
      const blocks = [{ id: 'hero-1', type: 'hero', props: { heading: 'Hi' } }];
      const about = await corrickPage({
        title: 'About',
        slug: 'about',
        path: '/about',
        status: ContentStatus.Published,
        blocks,
        data: { tagline: 'Since 1990' },
      });
      await bakeryPage({
        title: 'About the bakery',
        slug: 'about',
        path: '/about',
      });

      const found = await pages.findById(corrick, about.id);

      expect(found).toMatchObject({
        id: about.id,
        siteId: corrick,
        title: 'About',
        slug: 'about',
        path: '/about',
        status: ContentStatus.Published,
        blocks,
      });
      expect(found?.data).toEqual({ tagline: 'Since 1990' });
    });

    it('[UC-SR-02] lists all my pages, and exactly the drafts when filtered by status', async () => {
      const draftA = await corrickPage({
        title: 'Draft A',
        slug: 'draft-a',
        path: '/draft-a',
      });
      const draftB = await corrickPage({
        title: 'Draft B',
        slug: 'draft-b',
        path: '/draft-b',
      });
      const live = await corrickPage({
        title: 'Live',
        slug: 'live',
        path: '/live',
        status: ContentStatus.Published,
      });
      await bakeryPage({
        title: 'Bakery draft',
        slug: 'draft',
        path: '/draft',
      });

      const all = await pages.findMany(corrick);
      const drafts = await pages.findMany(corrick, {
        status: ContentStatus.Draft,
      });

      expect(sortedIds(all)).toEqual(sortedIds([draftA, draftB, live]));
      expect(sortedIds(drafts)).toEqual(sortedIds([draftA, draftB]));
    });

    it('[UC-SR-03] finds one of my pages by its full web path', async () => {
      const about = await corrickPage({
        title: 'About',
        slug: 'about',
        path: '/about',
      });
      const team = await corrickPage({
        title: 'Team',
        slug: 'team',
        path: '/about/team',
        parentId: about.id,
      });

      const found = await pages.findByPath(corrick, '/about/team');

      expect(found).toMatchObject({
        id: team.id,
        siteId: corrick,
        title: 'Team',
        path: '/about/team',
        parentId: about.id,
      });
    });

    it('[UC-SR-04] creates a draft page on my site with a new v7 id, timestamps, no blocks and no data', async () => {
      const created = await pages.create(corrick, {
        contentTypeId: corrickType.id,
        title: 'Contact',
        slug: 'contact',
        path: '/contact',
      });

      expect(created).toMatchObject({
        siteId: corrick,
        contentTypeId: corrickType.id,
        title: 'Contact',
        slug: 'contact',
        path: '/contact',
        status: ContentStatus.Draft,
      });
      expect(isUuid(created.id)).toBe(true);
      expect(uuidVersion(created.id)).toBe(7);
      expect(created.createdAt).toBeInstanceOf(Date);
      expect(created.updatedAt).toBeInstanceOf(Date);
      expect(created.blocks).toEqual([]);
      expect(created.data).toEqual({});
      expect(await pages.findById(corrick, created.id)).toMatchObject({
        id: created.id,
        siteId: corrick,
        title: 'Contact',
        path: '/contact',
      });
    });

    it('[UC-SR-05] updates the title and SEO title, moves updatedAt forward, and leaves every other field alone', async () => {
      const blocks = [
        { id: 'text-1', type: 'text', props: { html: '<p>Hi</p>' } },
      ];
      const about = await corrickPage({
        title: 'About',
        slug: 'about',
        path: '/about',
        status: ContentStatus.Published,
        blocks,
        createdAt: LONG_AGO,
        updatedAt: LONG_AGO,
      });

      const updated = await pages.update(corrick, about.id, {
        title: 'About us',
        seoTitle: 'About Corrick',
      });

      const expected = {
        id: about.id,
        siteId: corrick,
        title: 'About us',
        seoTitle: 'About Corrick',
        slug: 'about',
        path: '/about',
        status: ContentStatus.Published,
        blocks,
      };
      expect(updated).toMatchObject(expected);
      expect(updated?.updatedAt.getTime()).toBeGreaterThan(LONG_AGO.getTime());
      expect(await storedPage(about.id)).toMatchObject(expected);
    });

    it('[UC-SR-09] shows exactly my trashed pages, each with deletedAt set, and not the live one', async () => {
      const live = await corrickPage({
        title: 'Home',
        slug: 'home',
        path: '/home',
      });
      const oldOffer = await corrickTrashedPage({
        title: 'Old Offer',
        slug: 'old-offer',
        path: '/old-offer',
      });
      const oldNews = await corrickTrashedPage({
        title: 'Old News',
        slug: 'old-news',
        path: '/old-news',
      });
      await bakeryTrashedPage({
        title: 'Old Cake',
        slug: 'old-cake',
        path: '/old-cake',
      });

      const trash = await pages.findTrashed(corrick);

      expect(sortedIds(trash)).toEqual(sortedIds([oldOffer, oldNews]));
      expect(ids(trash)).not.toContain(live.id);
      for (const page of trash) {
        expect(page.deletedAt).toBeInstanceOf(Date);
      }
    });

    it("[UC-SR-10] the same path on two sites resolves to each site's own page", async () => {
      const corrickAbout = await corrickPage({
        title: 'About Corrick',
        slug: 'about',
        path: '/about',
      });
      const bakeryAbout = await bakeryPage({
        title: 'About the bakery',
        slug: 'about',
        path: '/about',
      });

      expect(await pages.findByPath(corrick, '/about')).toMatchObject({
        id: corrickAbout.id,
        siteId: corrick,
        title: 'About Corrick',
      });
      expect(await pages.findByPath(bakery, '/about')).toMatchObject({
        id: bakeryAbout.id,
        siteId: bakery,
        title: 'About the bakery',
      });
    });

    it('[UC-SR-14] a brand-new site with no content gets empty lists and null, not an error', async () => {
      const m = dataSource.manager;
      const florist = await m.save(
        m.create(Site, {
          organizationId: data.corrick.site.organizationId,
          name: 'Florist',
        }),
      );
      await corrickPage({ title: 'About', slug: 'about', path: '/about' });
      await bakeryTrashedPage({
        title: 'Old Cake',
        slug: 'old-cake',
        path: '/old-cake',
      });

      expect(await pages.findMany(florist.id)).toEqual([]);
      expect(await pages.findTrashed(florist.id)).toEqual([]);
      expect(await pages.findById(florist.id, randomUUID())).toBeNull();
    });

    it('[UC-SR-15] lists pages oldest first on every call, even after an older page was published', async () => {
      // Paths deliberately not in alphabetical order, so a list sorted by path would also be wrong.
      const first = await corrickPage({
        title: 'First',
        slug: 'zebra',
        path: '/zebra',
      });
      const second = await corrickPage({
        title: 'Second',
        slug: 'apple',
        path: '/apple',
      });
      const third = await corrickPage({
        title: 'Third',
        slug: 'mango',
        path: '/mango',
      });
      // Publishing changes `status`, an indexed column, so Postgres stores First's new version
      // after the other two (in the table and in the index). Checked on 2026-10-05: without an
      // ORDER BY, this list comes back with First last.
      await dataSource.query(
        `UPDATE content SET status = 'published', published_at = now() WHERE id = $1`,
        [first.id],
      );

      for (let call = 1; call <= 5; call++) {
        expect(ids(await pages.findMany(corrick))).toEqual(
          ids([first, second, third]),
        );
      }
    });

    it('[UC-SR-15] orders by creation time, then by id for pages created at the same moment', async () => {
      // Inserted in this order on purpose: neither table order, id order nor path order matches
      // creation time, so only "createdAt, then id" gives the expected list.
      const newest = await corrickPage({
        id: '00000000-0000-4000-8000-000000000001',
        title: 'Newest',
        slug: 'newest',
        path: '/newest',
        createdAt: new Date('2026-03-01T00:00:00.000Z'),
      });
      const tiedHigherId = await corrickPage({
        id: '00000000-0000-4000-8000-000000000003',
        title: 'Tied, higher id',
        slug: 'tied-higher',
        path: '/tied-higher',
        createdAt: new Date('2026-02-01T00:00:00.000Z'),
      });
      const oldest = await corrickPage({
        id: '00000000-0000-4000-8000-000000000004',
        title: 'Oldest',
        slug: 'oldest',
        path: '/oldest',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      });
      const tiedLowerId = await corrickPage({
        id: '00000000-0000-4000-8000-000000000002',
        title: 'Tied, lower id',
        slug: 'tied-lower',
        path: '/tied-lower',
        createdAt: new Date('2026-02-01T00:00:00.000Z'),
      });

      expect(ids(await pages.findMany(corrick))).toEqual(
        ids([oldest, tiedLowerId, tiedHigherId, newest]),
      );
    });

    it('[UC-SR-16] a trashed page is hidden from findById, findByPath and findMany', async () => {
      const home = await corrickPage({
        title: 'Home',
        slug: 'home',
        path: '/home',
      });
      const oldOffer = await corrickTrashedPage({
        title: 'Old Offer',
        slug: 'old-offer',
        path: '/old-offer',
      });

      expect(await pages.findById(corrick, oldOffer.id)).toBeNull();
      expect(await pages.findByPath(corrick, '/old-offer')).toBeNull();
      expect(ids(await pages.findMany(corrick))).toEqual([home.id]);
    });

    it('[UC-SR-17] updating a trashed page returns null and leaves the stored row as it was', async () => {
      const oldOffer = await corrickTrashedPage({
        title: 'Old Offer',
        slug: 'old-offer',
        path: '/old-offer',
      });

      expect(
        await pages.update(corrick, oldOffer.id, { title: 'Changed' }),
      ).toBeNull();

      const stored = await storedPage(oldOffer.id);
      expect(stored.title).toBe('Old Offer');
      expect(stored.deletedAt).toBeInstanceOf(Date);
    });

    it('[UC-SR-18] a trashed page keeps its path reserved: a new page there is refused by content_site_id_path_key', async () => {
      await corrickTrashedPage({
        title: 'Old Offer',
        slug: 'old-offer',
        path: '/old-offer',
      });

      const error = await pages
        .create(corrick, {
          contentTypeId: corrickType.id,
          title: 'New Offer',
          slug: 'old-offer',
          path: '/old-offer',
        })
        .catch((e: unknown) => e);

      expect(constraintOf(error)).toBe('content_site_id_path_key');
    });

    it('[UC-SR-19] an empty update returns the page as it is and writes nothing (updatedAt unchanged)', async () => {
      const about = await corrickPage({
        title: 'About',
        slug: 'about',
        path: '/about',
        createdAt: LONG_AGO,
        updatedAt: LONG_AGO,
      });

      const result = await pages.update(corrick, about.id, {});

      expect(result).toMatchObject({
        id: about.id,
        siteId: corrick,
        title: 'About',
        slug: 'about',
        path: '/about',
      });
      expect(result?.updatedAt).toEqual(LONG_AGO);
      expect((await storedPage(about.id)).updatedAt).toEqual(LONG_AGO);
    });

    it('[UC-SR-20] blocks and data come back exactly as saved, with null (not undefined) for an empty parent and trash date', async () => {
      const blocks = [
        {
          id: 'hero-1',
          type: 'hero',
          props: {
            heading: 'Fresh bread 🥖 every "morning"',
            note: '<b>Open</b> at 7',
          },
        },
        {
          id: 'columns-1',
          type: 'columns',
          props: {
            columns: [
              {
                blocks: [
                  {
                    id: 'text-1',
                    type: 'text',
                    props: { html: `<b>Baker's</b> dozen 🍩 "13"` },
                  },
                ],
              },
            ],
          },
        },
      ];
      const pageData = {
        subtitle: 'Family run — "since 1990" ☕',
        servings: 12,
        glutenFree: true,
      };

      const created = await pages.create(corrick, {
        contentTypeId: corrickType.id,
        title: 'Menu',
        slug: 'menu',
        path: '/menu',
        blocks,
        data: pageData,
      });
      const found = await pages.findById(corrick, created.id);

      expect(found?.blocks).toEqual(blocks);
      expect(found?.data).toEqual(pageData);
      expect(found?.parentId).toBeNull();
      expect(found?.deletedAt).toBeNull();
      expect(found?.createdAt).toBeInstanceOf(Date);
    });

    it('[UC-SR-21] hostile, huge, wildcard or empty paths find nothing and raise no error', async () => {
      await corrickPage({ title: 'About', slug: 'about', path: '/about' });
      await bakeryPage({ title: 'Menu', slug: 'menu', path: '/menu' });

      const paths = [
        "/x' OR '1'='1",
        `/${'a'.repeat(9_999)}`, // 10,000 characters
        '/%', // would match every path if used as a LIKE pattern
        '/abou_', // would match /about as a LIKE pattern
        '/about%_;--',
        '/about;--',
        '',
      ];
      for (const path of paths) {
        await expect(
          pages.findByPath(corrick, path),
          `findByPath(${JSON.stringify(path.slice(0, 40))})`,
        ).resolves.toBeNull();
      }
    });

    it('[UC-SR-22] a siteId or id slipped into create is ignored: the page is mine, with a fresh id', async () => {
      const bakeryMenu = await bakeryPage({
        title: 'Menu',
        slug: 'menu',
        path: '/menu',
        createdAt: LONG_AGO,
        updatedAt: LONG_AGO,
      });

      const created = await pages.create(corrick, {
        contentTypeId: corrickType.id,
        title: 'Contact',
        slug: 'contact',
        path: '/contact',
        siteId: bakery,
        id: bakeryMenu.id,
      } as never);

      expect(created.siteId).toBe(corrick);
      expect(created.id).not.toBe(bakeryMenu.id);
      expect(isUuid(created.id)).toBe(true);
      expect(await storedPage(created.id)).toMatchObject({
        siteId: corrick,
        title: 'Contact',
        path: '/contact',
      });
      expect(await storedPage(bakeryMenu.id)).toMatchObject({
        siteId: bakery,
        title: 'Menu',
        path: '/menu',
        updatedAt: LONG_AGO,
      });
    });

    it("[UC-SR-23] a siteId or id slipped into update is ignored: my page changes, the other site's does not", async () => {
      const about = await corrickPage({
        title: 'About',
        slug: 'about',
        path: '/about',
      });
      const bakeryMenu = await bakeryPage({
        title: 'Menu',
        slug: 'menu',
        path: '/menu',
        createdAt: LONG_AGO,
        updatedAt: LONG_AGO,
      });

      const updated = await pages.update(corrick, about.id, {
        title: 'X',
        siteId: bakery,
        id: bakeryMenu.id,
      } as never);

      expect(updated).toMatchObject({
        id: about.id,
        siteId: corrick,
        title: 'X',
      });
      expect(await storedPage(about.id)).toMatchObject({
        siteId: corrick,
        title: 'X',
      });
      expect(await storedPage(bakeryMenu.id)).toMatchObject({
        siteId: bakery,
        title: 'Menu',
        updatedAt: LONG_AGO,
      });
    });

    it('[UC-SR-24] two creates at the same path at the same moment: one wins, one is refused, one page exists', async () => {
      const createNews = (title: string) =>
        pages.create(corrick, {
          contentTypeId: corrickType.id,
          title,
          slug: 'news',
          path: '/news',
        });

      const results = await Promise.allSettled([
        createNews('News one'),
        createNews('News two'),
      ]);

      const fulfilled = results.filter(
        (result) => result.status === 'fulfilled',
      );
      const rejected = results.filter(
        (result): result is PromiseRejectedResult =>
          result.status === 'rejected',
      );
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(constraintOf(rejected[0].reason)).toBe('content_site_id_path_key');
      expect(
        await dataSource.manager.count(Content, {
          where: { siteId: corrick, path: '/news' },
          withDeleted: true,
        }),
      ).toBe(1);
    });

    it('[UC-SR-25] rows written outside the desks, by hand-written SQL or the seed helper, read back correctly', async () => {
      // Hand-written SQL that leaves `id` (and every other defaulted column) to the database, the
      // way a seed script, a data migration or old data would.
      const [{ id: legacyTypeId }] = await dataSource.query<{ id: string }[]>(
        `INSERT INTO content_types (site_id, name, slug) VALUES ($1, 'Legacy', 'legacy') RETURNING id`,
        [corrick],
      );
      const [{ id: importedId }] = await dataSource.query<{ id: string }[]>(
        `INSERT INTO content (site_id, content_type_id, title, slug, path)
         VALUES ($1, $2, 'Imported', 'imported', '/imported') RETURNING id`,
        [corrick, legacyTypeId],
      );
      const seeded = await corrickPage({
        title: 'Seeded',
        slug: 'seeded',
        path: '/seeded',
      });

      expect(await pageTypes.findById(corrick, legacyTypeId)).toMatchObject({
        id: legacyTypeId,
        siteId: corrick,
        name: 'Legacy',
        slug: 'legacy',
        urlPrefix: null,
        fields: [],
        hierarchical: false,
        createdAt: expect.any(Date),
      });
      expect(ids(await pageTypes.findMany(corrick))).toContain(legacyTypeId);

      const imported = await pages.findById(corrick, importedId);
      expect(imported).toMatchObject({
        id: importedId,
        siteId: corrick,
        contentTypeId: legacyTypeId,
        title: 'Imported',
        slug: 'imported',
        path: '/imported',
        status: ContentStatus.Draft,
        blocks: [],
        parentId: null,
        deletedAt: null,
        createdAt: expect.any(Date),
      });
      expect(imported?.data).toEqual({});
      expect(await pages.findById(corrick, seeded.id)).toMatchObject({
        id: seeded.id,
        siteId: corrick,
        title: 'Seeded',
        path: '/seeded',
      });
      expect(sortedIds(await pages.findMany(corrick))).toEqual(
        [importedId, seeded.id].sort(),
      );
    });

    it("[UC-SR-30] a page pointing at another site's page type is refused by content_site_id_content_type_id_fkey", async () => {
      const cake = await seedContentType(dataSource, {
        siteId: bakery,
        name: 'Cake',
        slug: 'cake',
      });
      const before = await countPages(corrick);

      const error = await pages
        .create(corrick, {
          contentTypeId: cake.id,
          title: 'Cake',
          slug: 'cake',
          path: '/cake',
        })
        .catch((e: unknown) => e);

      expect(constraintOf(error)).toBe('content_site_id_content_type_id_fkey');
      expect(await countPages(corrick)).toBe(before);
    });

    it('[UC-SR-31] a second page at a path my site already uses is refused by content_site_id_path_key, and the first is untouched', async () => {
      const about = await corrickPage({
        title: 'About',
        slug: 'about',
        path: '/about',
        createdAt: LONG_AGO,
        updatedAt: LONG_AGO,
      });

      const error = await pages
        .create(corrick, {
          contentTypeId: corrickType.id,
          title: 'About again',
          slug: 'about',
          path: '/about',
        })
        .catch((e: unknown) => e);

      expect(constraintOf(error)).toBe('content_site_id_path_key');
      expect(await storedPage(about.id)).toMatchObject({
        title: 'About',
        slug: 'about',
        path: '/about',
        updatedAt: LONG_AGO,
      });
    });

    it('[UC-SR-32] a page with no title, path or type is refused by the database and nothing is saved', async () => {
      await corrickPage({ title: 'About', slug: 'about', path: '/about' });
      await corrickPage({
        title: 'Contact',
        slug: 'contact',
        path: '/contact',
      });
      const before = await countPages(corrick);

      const error = await pages
        .create(corrick, { slug: 'x' } as never)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(QueryFailedError);
      expect(await countPages(corrick)).toBe(before);
    });

    const addressChanges: {
      change: string;
      patch: (otherPage: Content) => Record<string, unknown>;
    }[] = [
      { change: 'a slug change', patch: () => ({ slug: 'about-us' }) },
      { change: 'a path change', patch: () => ({ path: '/about-us' }) },
      { change: 'a parent change', patch: (other) => ({ parentId: other.id }) },
      {
        change: 'a slug change sent along with a title change',
        patch: () => ({ title: 'About us', slug: 'about-us' }),
      },
    ];

    for (const { change, patch } of addressChanges) {
      it(`[UC-SR-34] update refuses ${change}, pointing at the dedicated address operation, and writes nothing`, async () => {
        const about = await corrickPage({
          title: 'About',
          slug: 'about',
          path: '/about',
          createdAt: LONG_AGO,
          updatedAt: LONG_AGO,
        });
        const team = await corrickPage({
          title: 'Team',
          slug: 'team',
          path: '/about/team',
          parentId: about.id,
          createdAt: LONG_AGO,
          updatedAt: LONG_AGO,
        });
        const contact = await corrickPage({
          title: 'Contact',
          slug: 'contact',
          path: '/contact',
        });

        await expect(async () =>
          pages.update(corrick, about.id, patch(contact) as never),
        ).rejects.toThrow(/dedicated address operation/i);

        expect(await storedPage(about.id)).toMatchObject({
          title: 'About',
          slug: 'about',
          path: '/about',
          parentId: null,
          updatedAt: LONG_AGO,
        });
        expect(await storedPage(team.id)).toMatchObject({
          slug: 'team',
          path: '/about/team',
          parentId: about.id,
          updatedAt: LONG_AGO,
        });
      });
    }

    it("[UC-SR-35] another site's page is invisible by id, exactly like an id that does not exist", async () => {
      const menu = await bakeryPage({
        title: 'Menu',
        slug: 'menu',
        path: '/menu',
      });

      expect(await pages.findById(corrick, menu.id)).toBeNull();
      expect(await pages.findById(corrick, randomUUID())).toBeNull();
      // The page is really there: its own site sees it.
      expect(await pages.findById(bakery, menu.id)).toMatchObject({
        id: menu.id,
      });
    });

    it("[UC-SR-36] lists never include another site's pages, even with a smuggled siteId or a foreign page type id", async () => {
      const mine = [
        await corrickPage({ title: 'About', slug: 'about', path: '/about' }),
        await corrickPage({
          title: 'Contact',
          slug: 'contact',
          path: '/contact',
        }),
      ];
      for (const slug of ['menu', 'cakes', 'visit']) {
        await bakeryPage({ title: slug, slug, path: `/${slug}` });
      }

      expect(sortedIds(await pages.findMany(corrick))).toEqual(sortedIds(mine));
      expect(
        sortedIds(await pages.findMany(corrick, { siteId: bakery } as never)),
      ).toEqual(sortedIds(mine));
      expect(
        await pages.findMany(corrick, { contentTypeId: bakeryType.id }),
      ).toEqual([]);
    });

    it("[UC-SR-37] another site's path is invisible", async () => {
      const menu = await bakeryPage({
        title: 'Menu',
        slug: 'menu',
        path: '/menu',
      });

      expect(await pages.findByPath(corrick, '/menu')).toBeNull();
      // The page is really there: its own site finds it.
      expect(await pages.findByPath(bakery, '/menu')).toMatchObject({
        id: menu.id,
      });
    });

    it("[UC-SR-38] another site's trash is invisible", async () => {
      await corrickPage({ title: 'Home', slug: 'home', path: '/home' });
      const oldCake = await bakeryTrashedPage({
        title: 'Old Cake',
        slug: 'old-cake',
        path: '/old-cake',
      });

      expect(await pages.findTrashed(corrick)).toEqual([]);
      // The trashed page is really there: its own site sees it.
      expect(ids(await pages.findTrashed(bakery))).toEqual([oldCake.id]);
    });

    it("[UC-SR-39] updating another site's page returns null and changes nothing", async () => {
      const menu = await bakeryPage({
        title: 'Menu',
        slug: 'menu',
        path: '/menu',
        createdAt: LONG_AGO,
        updatedAt: LONG_AGO,
      });

      expect(
        await pages.update(corrick, menu.id, { title: 'Hacked' }),
      ).toBeNull();

      expect(await pages.findById(bakery, menu.id)).toMatchObject({
        title: 'Menu',
        updatedAt: LONG_AGO,
      });
    });
  });

  describe('page types desk', () => {
    it('[UC-SR-06] creates, reads, finds by slug, lists and renames my page type', async () => {
      // Bakery's own type must stay out of every answer below.
      await seedContentType(dataSource, {
        siteId: bakery,
        name: 'Cake',
        slug: 'cake',
      });

      const created = await pageTypes.create(corrick, {
        name: 'Event',
        slug: 'event',
      });

      expect(created).toMatchObject({
        siteId: corrick,
        name: 'Event',
        slug: 'event',
      });
      expect(isUuid(created.id)).toBe(true);
      expect(await pageTypes.findById(corrick, created.id)).toMatchObject({
        id: created.id,
        siteId: corrick,
        name: 'Event',
        slug: 'event',
      });
      expect(await pageTypes.findBySlug(corrick, 'event')).toMatchObject({
        id: created.id,
        name: 'Event',
      });
      expect(ids(await pageTypes.findMany(corrick))).toEqual([created.id]);

      const before = await dataSource.manager.findOneByOrFail(ContentType, {
        id: created.id,
      });
      const updated = await pageTypes.update(corrick, created.id, {
        name: 'Events',
      });

      expect(updated).toMatchObject({
        id: created.id,
        siteId: corrick,
        name: 'Events',
        slug: 'event',
      });
      const after = await dataSource.manager.findOneByOrFail(ContentType, {
        id: created.id,
      });
      // Only the name changed (updatedAt is allowed to move).
      expect(after).toEqual({
        ...before,
        name: 'Events',
        updatedAt: after.updatedAt,
      });
    });

    it("[UC-SR-11] the same page type slug on two sites resolves to each site's own type", async () => {
      const corrickEvent = await seedContentType(dataSource, {
        siteId: corrick,
        name: 'Event',
        slug: 'event',
      });
      const bakeryEvent = await seedContentType(dataSource, {
        siteId: bakery,
        name: 'Tasting',
        slug: 'event',
      });

      expect(await pageTypes.findBySlug(corrick, 'event')).toMatchObject({
        id: corrickEvent.id,
        siteId: corrick,
        name: 'Event',
      });
      expect(await pageTypes.findBySlug(bakery, 'event')).toMatchObject({
        id: bakeryEvent.id,
        siteId: bakery,
        name: 'Tasting',
      });
    });

    it("[UC-SR-40] another site's page type is invisible and untouchable", async () => {
      const event = await seedContentType(dataSource, {
        siteId: corrick,
        name: 'Event',
        slug: 'event',
      });
      const cake = await seedContentType(dataSource, {
        siteId: bakery,
        name: 'Cake',
        slug: 'cake',
        createdAt: LONG_AGO,
        updatedAt: LONG_AGO,
      });

      expect(await pageTypes.findById(corrick, cake.id)).toBeNull();
      expect(await pageTypes.findBySlug(corrick, 'cake')).toBeNull();
      expect(ids(await pageTypes.findMany(corrick))).toEqual([event.id]);
      expect(
        await pageTypes.update(corrick, cake.id, { name: 'Hacked' }),
      ).toBeNull();
      expect(await pageTypes.findById(bakery, cake.id)).toMatchObject({
        name: 'Cake',
        slug: 'cake',
        updatedAt: LONG_AGO,
      });
    });
  });

  describe('either desk, given a bad id or site id', () => {
    let corrickType: ContentType;
    let bakeryType: ContentType;
    let bakeryAbout: Content;

    beforeEach(async () => {
      // Both sites have page types, draft pages and trashed pages, so a query that lost its site
      // condition would visibly return or change rows.
      corrickType = await seedContentType(dataSource, { siteId: corrick });
      bakeryType = await seedContentType(dataSource, { siteId: bakery });
      await seedPage(dataSource, {
        siteId: corrick,
        contentTypeId: corrickType.id,
        title: 'About Corrick',
        slug: 'about',
        path: '/about',
      });
      bakeryAbout = await seedPage(dataSource, {
        siteId: bakery,
        contentTypeId: bakeryType.id,
        title: 'About the bakery',
        slug: 'about',
        path: '/about',
      });
      await seedTrashedPage(dataSource, {
        siteId: corrick,
        contentTypeId: corrickType.id,
        title: 'Old Offer',
        slug: 'old-offer',
        path: '/old-offer',
      });
      await seedTrashedPage(dataSource, {
        siteId: bakery,
        contentTypeId: bakeryType.id,
        title: 'Old Cake',
        slug: 'old-cake',
        path: '/old-cake',
      });
    });

    it('[UC-SR-27] an id that is not a valid uuid is "not found" on both desks, with no database error', async () => {
      await expect(pages.findById(corrick, 'not-a-uuid')).resolves.toBeNull();
      await expect(
        pages.update(corrick, 'not-a-uuid', { title: 'X' }),
      ).resolves.toBeNull();
      await expect(
        pageTypes.findById(corrick, 'not-a-uuid'),
      ).resolves.toBeNull();
      await expect(
        pageTypes.update(corrick, 'not-a-uuid', { name: 'X' }),
      ).resolves.toBeNull();
    });

    /**
     * Every public method of both desks, given `siteId` and otherwise valid input. The reads and
     * writes aim at Bakery's rows, so a guard that let the call through would leak across sites.
     * Each call is `async` so a synchronous throw counts the same as a rejection.
     */
    const deskCalls: {
      method: string;
      call: (siteId: unknown) => Promise<unknown>;
    }[] = [
      {
        method: 'pages.findById',
        call: async (siteId) => pages.findById(siteId as never, bakeryAbout.id),
      },
      {
        method: 'pages.findMany',
        call: async (siteId) => pages.findMany(siteId as never),
      },
      {
        method: "pages.findMany({ status: 'draft' })",
        call: async (siteId) =>
          pages.findMany(siteId as never, { status: ContentStatus.Draft }),
      },
      {
        method: 'pages.findByPath',
        call: async (siteId) => pages.findByPath(siteId as never, '/about'),
      },
      {
        method: 'pages.findTrashed',
        call: async (siteId) => pages.findTrashed(siteId as never),
      },
      {
        method: 'pages.create',
        call: async (siteId) =>
          pages.create(siteId as never, {
            contentTypeId: bakeryType.id,
            title: 'Contact',
            slug: 'contact',
            path: '/contact',
          }),
      },
      {
        method: 'pages.update',
        call: async (siteId) =>
          pages.update(siteId as never, bakeryAbout.id, { title: 'Hacked' }),
      },
      {
        method: 'pageTypes.findById',
        call: async (siteId) =>
          pageTypes.findById(siteId as never, bakeryType.id),
      },
      {
        method: 'pageTypes.findBySlug',
        call: async (siteId) => pageTypes.findBySlug(siteId as never, 'page'),
      },
      {
        method: 'pageTypes.findMany',
        call: async (siteId) => pageTypes.findMany(siteId as never),
      },
      {
        method: 'pageTypes.create',
        call: async (siteId) =>
          pageTypes.create(siteId as never, { name: 'Event', slug: 'event' }),
      },
      {
        method: 'pageTypes.update',
        call: async (siteId) =>
          pageTypes.update(siteId as never, bakeryType.id, { name: 'Hacked' }),
      },
    ];

    const missingSiteIds = [
      { label: 'undefined', siteId: undefined },
      { label: 'null', siteId: null },
      { label: 'an empty string', siteId: '' },
    ];
    for (const { label, siteId } of missingSiteIds) {
      for (const { method, call } of deskCalls) {
        it(`[UC-SR-28] ${method} refuses a siteId of ${label} before any query, returning and changing nothing`, async () => {
          await expectRefusedBeforeAnyQuery(
            () => call(siteId),
            /site id is required/i,
          );
        });
      }
    }

    for (const siteId of ['abc', '1']) {
      for (const { method, call } of deskCalls) {
        it(`[UC-SR-29] ${method} refuses the malformed siteId '${siteId}' with the same clear error, not a database 22P02`, async () => {
          await expectRefusedBeforeAnyQuery(
            () => call(siteId),
            /site id is required/i,
          );
        });
      }
    }
  });

  describe('either desk, given a system-managed field in an update', () => {
    /** Neither row's own date, so writing it would show. */
    const OTHER_DATE = new Date('2025-06-01T00:00:00.000Z');
    let about: Content;
    let event: ContentType;

    beforeEach(async () => {
      const pageType = await seedContentType(dataSource, { siteId: corrick });
      about = await seedPage(dataSource, {
        siteId: corrick,
        contentTypeId: pageType.id,
        title: 'About',
        slug: 'about',
        path: '/about',
        createdAt: LONG_AGO,
        updatedAt: LONG_AGO,
      });
      event = await seedContentType(dataSource, {
        siteId: corrick,
        name: 'Event',
        slug: 'event',
        createdAt: LONG_AGO,
        updatedAt: LONG_AGO,
      });
    });

    /**
     * Each patch carries a field the system owns: the trash date (trashing gets its own
     * operation in CNT-11) or a timestamp (TypeORM sets those). Cast past the types, which refuse
     * them too (test/scoped-repository-types.spec.ts). A plain update that wrote `deletedAt`
     * would trash the page and then answer `null`, as if nothing had been written.
     */
    const systemFieldPatches: {
      patch: string;
      call: () => Promise<unknown>;
    }[] = [
      {
        patch: 'pages.update({ deletedAt })',
        call: async () =>
          pages.update(corrick, about.id, { deletedAt: new Date() } as never),
      },
      {
        patch: 'pages.update({ createdAt })',
        call: async () =>
          pages.update(corrick, about.id, { createdAt: OTHER_DATE } as never),
      },
      {
        patch: 'pages.update({ updatedAt })',
        call: async () =>
          pages.update(corrick, about.id, { updatedAt: OTHER_DATE } as never),
      },
      {
        patch: 'pages.update({ title, deletedAt })',
        call: async () =>
          pages.update(corrick, about.id, {
            title: 'About us',
            deletedAt: new Date(),
          } as never),
      },
      {
        patch: 'pageTypes.update({ createdAt })',
        call: async () =>
          pageTypes.update(corrick, event.id, {
            createdAt: OTHER_DATE,
          } as never),
      },
      {
        patch: 'pageTypes.update({ updatedAt })',
        call: async () =>
          pageTypes.update(corrick, event.id, {
            updatedAt: OTHER_DATE,
          } as never),
      },
    ];

    for (const { patch, call } of systemFieldPatches) {
      it(`[UC-SR-56] ${patch} is refused as managed by the system, before any query, writing nothing`, async () => {
        await expectRefusedBeforeAnyQuery(call, /managed by the system/i);

        // About is still live, and both rows keep their own timestamps.
        expect(await storedPage(about.id)).toMatchObject({
          title: 'About',
          deletedAt: null,
          createdAt: LONG_AGO,
          updatedAt: LONG_AGO,
        });
        expect(
          await dataSource.manager.findOneByOrFail(ContentType, {
            id: event.id,
          }),
        ).toMatchObject({ createdAt: LONG_AGO, updatedAt: LONG_AGO });
      });
    }
  });
});
