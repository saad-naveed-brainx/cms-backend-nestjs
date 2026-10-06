import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { createTestApp } from './support/app.js';
import { resetDatabase } from './support/database.js';
import { seedHostname, seedTwoSites } from './support/seed.js';

/**
 * A database that has gone away must surface as a 500 on the resolve endpoint, never as a 404:
 * otherwise an outage would look like "no site lives here", and the website would show a missing
 * site while the real problem stayed hidden. The failure must not be remembered as "unknown" either.
 *
 * Its own file because it closes the app's database connection on purpose, as
 * test/scoped-repository-db-failure.e2e-spec.ts does: no fake, the resolver and the desks run
 * exactly as in production against a connection that refuses every query. The app is new, so
 * nothing is cached: the first request really has to ask the database.
 */
describe('GET /sites/resolve when the database connection fails', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  beforeAll(async () => {
    ({ app, dataSource } = await createTestApp());

    // An address that really exists, so a 404 would be a wrong answer, not a right one.
    await resetDatabase(dataSource);
    const { corrick } = await seedTwoSites(dataSource);
    await seedHostname(dataSource, corrick.site.id, 'corrick.test', true);

    await dataSource.destroy();
  });

  afterAll(async () => {
    // Nest skips closing a connection that is already closed.
    await app.close();
  });

  it('[UC-HR-16] answers 500, not 404, and does not remember the failure as "unknown"', async () => {
    // Twice: were the first failure cached as "no site answers here", the second request would be
    // a 404 served from memory, while the database is still down.
    for (const attempt of ['first', 'second']) {
      const res = await request(app.getHttpServer())
        .get('/sites/resolve')
        .query({ host: 'corrick.test' });

      expect(res.status, `${attempt} request`).toBe(500);
      expect(res.body.site, `${attempt} request`).toBeUndefined();
    }
  });
});
