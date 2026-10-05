import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { ContentTypeRepository } from '../src/content-types/content-type.repository.js';
import { ContentRepository } from '../src/content/content.repository.js';
import type { Content, ContentType } from '../src/database/entities/index.js';
import { createTestApp } from './support/app.js';
import { resetDatabase } from './support/database.js';
import { seedContentType, seedPage, seedTwoSites } from './support/seed.js';

/**
 * A database that has gone away must surface as an error, never as "not found". Otherwise an
 * outage would look like missing pages (a 404 instead of a 500) and hide the real problem.
 *
 * Its own file because it closes the app's database connection on purpose: no fake, the desks
 * run exactly as in production against a connection that refuses every query.
 */
describe('the desks when the database connection fails', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let pages: ContentRepository;
  let pageTypes: ContentTypeRepository;
  let siteId: string;
  let pageType: ContentType;
  let page: Content;
  /** What the closed connection throws for any query, e.g. "Driver not Connected". */
  let connectionError: Error;

  beforeAll(async () => {
    ({ app, dataSource } = await createTestApp());
    pages = app.get(ContentRepository);
    pageTypes = app.get(ContentTypeRepository);

    // A page and a page type that really exist, so a quiet `null` would be a wrong answer.
    await resetDatabase(dataSource);
    siteId = (await seedTwoSites(dataSource)).corrick.site.id;
    pageType = await seedContentType(dataSource, { siteId });
    page = await seedPage(dataSource, {
      siteId,
      contentTypeId: pageType.id,
      title: 'About',
      slug: 'about',
      path: '/about',
    });

    await dataSource.destroy();
    const refusal: unknown = await dataSource.query('SELECT 1').then(
      () => undefined,
      (error: unknown) => error,
    );
    if (!(refusal instanceof Error) || !refusal.message) {
      throw new Error(
        'setup: expected the closed connection to refuse queries',
      );
    }
    connectionError = refusal;
  });

  afterAll(async () => {
    // Nest skips closing a connection that is already closed.
    await app.close();
  });

  const calls: { method: string; call: () => Promise<unknown> }[] = [
    { method: 'pages.findById', call: () => pages.findById(siteId, page.id) },
    {
      method: 'pages.findByPath',
      call: () => pages.findByPath(siteId, '/about'),
    },
    {
      method: 'pages.update',
      call: () => pages.update(siteId, page.id, { title: 'About us' }),
    },
    { method: 'pages.findMany', call: () => pages.findMany(siteId) },
    { method: 'pages.findTrashed', call: () => pages.findTrashed(siteId) },
    {
      method: 'pageTypes.findById',
      call: () => pageTypes.findById(siteId, pageType.id),
    },
    {
      method: 'pageTypes.findBySlug',
      call: () => pageTypes.findBySlug(siteId, 'page'),
    },
    { method: 'pageTypes.findMany', call: () => pageTypes.findMany(siteId) },
    {
      method: 'pageTypes.update',
      call: () => pageTypes.update(siteId, pageType.id, { name: 'Pages' }),
    },
  ];

  for (const { method, call } of calls) {
    it(`[UC-SR-33] ${method} rejects with the database error instead of answering null or []`, async () => {
      await expect(call()).rejects.toThrow(connectionError.message);
    });
  }
});
