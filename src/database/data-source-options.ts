import type { DataSourceOptions } from 'typeorm';
import { ENTITIES } from './entities/index.js';
import { SnakeNamingStrategy } from './snake-naming.strategy.js';

/**
 * One source of connection options for both the Nest app and the migration CLI, so the two can
 * never disagree about entities or naming.
 *
 * `synchronize` is off on purpose: it alters the live schema to match the entities on boot and
 * can drop columns along with their data. Every schema change goes through a migration.
 */
export function buildDataSourceOptions(url: string): DataSourceOptions {
  return {
    type: 'postgres',
    url,
    entities: ENTITIES,
    namingStrategy: new SnakeNamingStrategy(),
    synchronize: false,
    migrationsRun: false,
  };
}
