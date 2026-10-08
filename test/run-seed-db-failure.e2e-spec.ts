import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { runSeed } from '../src/cli/run-seed.js';
import { ProvisioningService } from '../src/provisioning/provisioning.service.js';
import { createTestApp } from './support/app.js';
import { resetDatabase } from './support/database.js';
import { recordingIo, tenantInput } from './support/tenant.js';

/**
 * A database that has gone away, seen from the seed command (FND-06): the command answers with
 * exit code 1 and the error's message on one line, never a stack dump, and still closes the app
 * it opened. No fake database: the real service runs against a connection that refuses every
 * query, as in test/sites-resolve-db-failure.e2e-spec.ts. Its own file because it closes the app's
 * database connection on purpose.
 */

const ARGV = [
  '--organization',
  'Delta Holdings',
  '--site',
  'Delta Bakery',
  '--host',
  'delta.test',
  '--email',
  'dev@delta.test',
  '--name',
  'Dev Delta',
];

describe('runSeed when the database connection fails', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let provisioning: ProvisioningService;

  beforeAll(async () => {
    ({ app, dataSource } = await createTestApp());
    provisioning = app.get(ProvisioningService);
    await resetDatabase(dataSource);
    await dataSource.destroy();
  });

  afterAll(async () => {
    // Nest skips closing a connection that is already closed.
    await app.close();
  });

  it('[UC-TS-12] exits 1 with the error message on one line and no stack, and still closes the app once', async () => {
    // What the closed connection really throws, asked of the service directly.
    const thrown: unknown = await provisioning
      .provisionTenant(tenantInput())
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    if (!(thrown instanceof Error) || !thrown.message) {
      throw new Error('setup: expected the closed connection to refuse');
    }
    const firstLine = thrown.message.split('\n')[0];

    const { io, err } = recordingIo();
    let closed = 0;
    const code = await runSeed(ARGV, {}, io, async () => ({
      provisioning,
      close: async () => {
        closed += 1;
      },
    }));

    expect(code).toBe(1);
    expect(err).toHaveLength(1);
    expect(err[0]).toContain(firstLine);
    expect(err[0]).not.toContain('\n');
    expect(err[0]).not.toContain(thrown.stack as string);
    expect(err[0]).not.toMatch(/\bat\s.+:\d+:\d+/);
    expect(closed).toBe(1);
  });
});
