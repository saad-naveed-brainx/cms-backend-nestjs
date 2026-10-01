import { defineConfig } from 'vitest/config';
import { testDatabaseUrl } from './test/support/test-database.js';

// API tests run against `<app database>_test`, never the app database itself.
try {
  process.loadEnvFile();
} catch {
  // No .env file (CI): DATABASE_URL comes from the real environment.
}
const databaseUrl = testDatabaseUrl(process.env.DATABASE_URL);
process.env.DATABASE_URL = databaseUrl;

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    env: { DATABASE_URL: databaseUrl },
    globalSetup: ['./test/support/global-setup.ts'],
    // One shared test database: run files one at a time so resets don't race.
    fileParallelism: false,
  },
});
