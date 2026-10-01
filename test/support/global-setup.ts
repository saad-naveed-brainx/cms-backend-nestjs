import { readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../../src/database/data-source-options.js';
import { databaseName } from './test-database.js';

const migrationsDir = fileURLToPath(
  new URL('../../src/database/migrations/', import.meta.url),
);

/**
 * Runs once before the API tests: creates the test database if it is missing, then brings its
 * schema up to date with the same migrations production uses. `DATABASE_URL` here is already
 * the test database (set in vitest.config.e2e.ts).
 */
export default async function setup(): Promise<void> {
  const url = process.env.DATABASE_URL!;
  await createDatabaseIfMissing(url);

  const migrations = [];
  for (const file of readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.ts'))
    .sort()) {
    const module = await import(pathToFileURL(`${migrationsDir}${file}`).href);
    migrations.push(
      ...Object.values(module).filter((value) => typeof value === 'function'),
    );
  }

  const dataSource = new DataSource({
    ...buildDataSourceOptions(url),
    migrations,
  });
  await dataSource.initialize();
  try {
    await dataSource.runMigrations();
  } finally {
    await dataSource.destroy();
  }
}

async function createDatabaseIfMissing(url: string): Promise<void> {
  const name = databaseName(url);
  const admin = new URL(url);
  admin.pathname = '/postgres';

  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const found = await client.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [name],
    );
    if (found.rowCount === 0) {
      // The name is validated as [a-z0-9_]+ in testDatabaseUrl, so quoting it is safe.
      await client.query(`CREATE DATABASE "${name}"`);
    }
  } finally {
    await client.end();
  }
}
