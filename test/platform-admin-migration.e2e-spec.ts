import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { AddPlatformAdmin1794474055974 } from '../src/database/migrations/1794474055974-AddPlatformAdmin.js';
import { createTestApp } from './support/app.js';

let app: INestApplication;
let dataSource: DataSource;

beforeAll(async () => {
  ({ app, dataSource } = await createTestApp());
});
afterAll(async () => {
  await app.close();
});

describe('the AddPlatformAdmin migration', () => {
  it('[UC-PA-40] keeps every organization, its owner and every account as they were', async () => {
    // Everything happens in one transaction that is rolled back: the schema goes back to what it was
    // before the migration, rows are written the old way, and the migration runs again over them.
    const migration = new AddPlatformAdmin1794474055974();
    const runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await migration.down(runner);
      const [user] = (await runner.query(
        `INSERT INTO users (email, name, password_hash) VALUES ('old-owner@mig.test', 'Old Owner', 'x') RETURNING id`,
      )) as { id: string }[];
      const [org] = (await runner.query(
        `INSERT INTO organizations (name, owner_id) VALUES ('Old Org', $1) RETURNING id`,
        [user.id],
      )) as { id: string }[];

      await migration.up(runner);

      const users = await runner.query(
        `SELECT is_platform_admin FROM users WHERE id = $1`,
        [user.id],
      );
      const orgs = await runner.query(
        `SELECT owner_id, suspended_at FROM organizations WHERE id = $1`,
        [org.id],
      );
      expect(users).toEqual([{ is_platform_admin: false }]);
      expect(orgs).toEqual([{ owner_id: user.id, suspended_at: null }]);
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
  });
});
