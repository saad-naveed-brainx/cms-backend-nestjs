import type { DataSourceOptions } from 'typeorm';
import { ENTITIES } from './entities/index.js';
import { SnakeNamingStrategy } from './snake-naming.strategy.js';

/**
 * One source of connection options for both the Nest app and the migration CLI, so the two can
 * never disagree about entities or naming.
 *
 * `synchronize` is off on purpose: it alters the live schema to match the entities on boot and
 * can drop columns along with their data. Every schema change goes through a migration.
 *
 * `migrationsTransactionMode: 'each'` runs every migration in its own transaction. Postgres cannot
 * use an enum value in the transaction that added it ("unsafe use of new enum value"), so a
 * migration adding a `permission` value must commit before a later one grants it. With TypeORM's
 * default ('all'), a fresh database (CI, the test database) would run both in one transaction.
 */
export function buildDataSourceOptions(url: string): DataSourceOptions {
  return {
    type: 'postgres',
    url,
    entities: ENTITIES,
    namingStrategy: new SnakeNamingStrategy(),
    synchronize: false,
    migrationsRun: false,
    migrationsTransactionMode: 'each',
  };
}
