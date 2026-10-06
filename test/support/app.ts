import type { INestApplication, Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module.js';

/**
 * The real Nest app, wired to the test database, without listening on a port.
 *
 * `extraControllers` registers controllers that only a test needs next to the real ones (the auth
 * probe in `probe.controller.ts`), so they sit behind the same global guards. Existing callers pass
 * nothing.
 */
export async function createTestApp(
  extraControllers: Type<unknown>[] = [],
): Promise<{
  app: INestApplication;
  dataSource: DataSource;
}> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
    controllers: extraControllers,
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return { app, dataSource: app.get(DataSource) };
}
