import { runSeed, type SeedApp } from '../src/cli/run-seed.js';
import {
  ProvisioningService,
  type ProvisionResult,
} from '../src/provisioning/provisioning.service.js';
import { recordingIo } from './support/tenant.js';

/**
 * `runSeed` and the application it opens (FND-06): whatever happens after the app is open, it is
 * closed exactly once, so the command never hangs on an open database connection. The app is a
 * fake that counts `open` and `close`; its service is a small fake, or the real `ProvisioningService`
 * whose collaborators are never reached (it refuses the input first), so that a rejected input is
 * the real `ProvisionInputError`. The real database failure is in run-seed-db-failure.e2e-spec.ts.
 */

const ARGV = [
  '--organization',
  'Cedar Holdings',
  '--site',
  'Cedar Bakery',
  '--host',
  'cedar.test',
  '--email',
  'cora@cedar.test',
  '--name',
  'Cora Cedar',
];

const RESULT: ProvisionResult = {
  organization: {
    id: '0198f2a0-0000-7000-8000-0000000000a1',
    name: 'Cedar Holdings',
  },
  site: { id: '0198f2a0-0000-7000-8000-0000000000a2', name: 'Cedar Bakery' },
  hostnames: ['cedar.test'],
  admin: {
    id: '0198f2a0-0000-7000-8000-0000000000a3',
    email: 'cora@cedar.test',
    created: true,
  },
};

/** An app whose `close` is counted, with `provisioning` as its service. */
function appWith(provisioning: unknown) {
  const calls = { opened: 0, closed: 0 };
  const openApp = async (): Promise<SeedApp> => {
    calls.opened += 1;
    return {
      provisioning: provisioning as ProvisioningService,
      close: async () => {
        calls.closed += 1;
      },
    };
  };
  return { calls, openApp };
}

describe('runSeed', () => {
  it('[UC-TS-12] closes the app exactly once after a success, a rejected input and a failure nobody expected, and prints no stack', async () => {
    const unreached = () => {
      throw new Error('the input is refused before anything else is asked');
    };
    const realService = new ProvisioningService(
      { findUserByEmail: unreached } as never,
      { hash: unreached } as never,
      { createTenant: unreached } as never,
      { invalidateSite: unreached } as never,
    );
    const databaseError = new Error('connection terminated unexpectedly');

    const rows: {
      what: string;
      provisioning: unknown;
      env: Record<string, string>;
      exitCode: number;
    }[] = [
      {
        what: 'a success',
        provisioning: { provisionTenant: async () => RESULT },
        env: {},
        exitCode: 0,
      },
      {
        what: 'a rejected input (a password of 11 characters)',
        provisioning: realService,
        env: { SEED_ADMIN_PASSWORD: 'elevenchars' },
        exitCode: 1,
      },
      {
        what: 'a database failure',
        provisioning: {
          provisionTenant: async () => {
            throw databaseError;
          },
        },
        env: {},
        exitCode: 1,
      },
    ];

    const errorLines: Record<string, string[]> = {};
    for (const { what, provisioning, env, exitCode } of rows) {
      const { calls, openApp } = appWith(provisioning);
      const { io, err } = recordingIo();

      const code = await runSeed(ARGV, env, io, openApp);

      expect(code, `${what}: exit code`).toBe(exitCode);
      expect(calls, `${what}: opened and closed`).toEqual({
        opened: 1,
        closed: 1,
      });
      errorLines[what] = err;
    }

    // A success says nothing on the error stream.
    expect(errorLines['a success']).toEqual([]);

    // A rejected input is explained, and the password that was too short is not repeated.
    const rejected =
      errorLines['a rejected input (a password of 11 characters)'];
    expect(rejected.join('\n')).toMatch(/password/i);
    expect(rejected.join('\n')).not.toContain('elevenchars');

    // A database failure is one line with the error's message, and no stack dump.
    const failed = errorLines['a database failure'];
    expect(failed).toHaveLength(1);
    expect(failed[0]).toContain('connection terminated unexpectedly');
    expect(failed[0]).not.toContain('\n');
    expect(failed[0]).not.toContain(databaseError.stack as string);
    expect(failed[0]).not.toMatch(/\bat\s.+:\d+:\d+/);

    // Arguments it refuses are refused before any app is opened, so there is nothing to close.
    const { calls, openApp } = appWith({ provisionTenant: async () => RESULT });
    const { io, err } = recordingIo();
    expect(await runSeed(['--organization'], {}, io, openApp)).toBe(1);
    expect(err.length).toBeGreaterThan(0);
    expect(calls).toEqual({ opened: 0, closed: 0 });
  });

  it('[UC-TS-12] when the application cannot open at all (the database is down), it answers with one line and exit code 1, and prints no stack', async () => {
    const failure = new Error('connect ECONNREFUSED\n    at the database');
    const { io, out, err } = recordingIo();

    const code = await runSeed(ARGV, {}, io, async () => {
      throw failure;
    });

    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(err).toHaveLength(1);
    expect(err[0]).toContain('ECONNREFUSED');
    expect(err[0]).not.toContain('\n');
    expect(err[0]).not.toContain(failure.stack as string);
  });
});
