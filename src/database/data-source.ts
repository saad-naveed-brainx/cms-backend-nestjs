import { fileURLToPath } from 'node:url';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from './data-source-options.js';

/**
 * Data source for the TypeORM CLI only (`npm run db:generate`, `db:migrate`, `db:revert`).
 * The Nest app builds its own connection in DatabaseModule.
 *
 * The CLI runs against the compiled output in `dist/`, so migrations are matched as `.js`
 * next to this file. Node loads `.env` itself here; the app gets it from @nestjs/config.
 */
try {
  process.loadEnvFile();
} catch {
  // No .env file: rely on the real environment, as in production.
}

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error('DATABASE_URL is not set');
}

export default new DataSource({
  ...buildDataSourceOptions(url),
  migrations: [fileURLToPath(new URL('./migrations/*.js', import.meta.url))],
});
