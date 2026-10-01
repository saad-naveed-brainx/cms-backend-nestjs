import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { buildDataSourceOptions } from './data-source-options.js';

/**
 * Opens the TypeORM connection for the app.
 *
 * Tenant scoping (invariant 1): only `*.repository.ts` files may inject `DataSource`,
 * `EntityManager` or `Repository<T>`. Services and controllers go through those repositories,
 * whose content methods all take `siteId`. The health check is the one infrastructure exception.
 */
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        buildDataSourceOptions(config.getOrThrow<string>('DATABASE_URL')),
    }),
  ],
})
export class DatabaseModule {}
