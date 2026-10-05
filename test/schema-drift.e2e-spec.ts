import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { createTestApp } from './support/app.js';

describe('database schema', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  beforeAll(async () => {
    ({ app, dataSource } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  it('[UC-SR-54] matches the entities exactly, so no migration is pending', async () => {
    // The comparison `npm run db:generate` makes before printing "No changes in database schema
    // were found": the SQL TypeORM would run to make the migrated test database match the entities.
    const pending = await dataSource.driver.createSchemaBuilder().log();

    expect(pending.upQueries.map((query) => query.query)).toEqual([]);
  });
});
