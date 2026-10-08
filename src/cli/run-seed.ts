import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import {
  ProvisioningService,
  type ProvisionResult,
} from '../provisioning/provisioning.service.js';
import {
  HostnameTakenError,
  ProvisionInputError,
} from '../provisioning/tenant-input.js';
import { parseSeedArgs } from './seed-args.js';

/** Where the command writes: one line per call. `err` is for everything that went wrong. */
export type SeedIo = {
  out: (line: string) => void;
  err: (line: string) => void;
};

/** The running application, as far as the command needs it. `close` must be called exactly once. */
export type SeedApp = {
  provisioning: ProvisioningService;
  close: () => Promise<void>;
};

/**
 * The real application, without an HTTP server: the same `AppModule`, so it needs the same
 * environment as the API (`DATABASE_URL`, `JWT_SECRET`). Logging is off, so the only output is
 * the command's own. `abortOnError: false` makes a start-up failure (no database, no secret) an
 * error this command can print, instead of Nest ending the process without a word.
 */
async function openNestApp(): Promise<SeedApp> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
    abortOnError: false,
  });
  return {
    provisioning: app.get(ProvisioningService),
    close: () => app.close(),
  };
}

/**
 * The seed command, as a function: it returns the exit code (0, or 1 for anything that went
 * wrong) and writes only to `io`, so a test can run it without a terminal and `seed.ts` only
 * wires it to the process. Arguments are checked before the application opens, so a bad command
 * line is answered at once. Once the application has opened it is closed exactly once, whatever
 * happens. Nothing here prints a supplied password or any hash.
 */
export async function runSeed(
  argv: string[],
  env: Record<string, string | undefined>,
  io: SeedIo,
  openApp: () => Promise<SeedApp> = openNestApp,
): Promise<number> {
  const args = parseSeedArgs(argv, env);
  if (!args.ok) {
    io.err(args.message);
    return 1;
  }

  let app: SeedApp;
  try {
    app = await openApp();
  } catch (error) {
    io.err(messageOf(error));
    return 1;
  }

  let exitCode = 1;
  try {
    report(await app.provisioning.provisionTenant(args.input), io);
    exitCode = 0;
  } catch (error) {
    io.err(messageOf(error));
  }

  try {
    await app.close();
  } catch (error) {
    // The work is already done or already failed: say so, and keep that exit code.
    io.err(`The application did not close cleanly: ${messageOf(error)}`);
  }
  return exitCode;
}

/** What the person running the command sees, and the one time a generated password is shown. */
function report(result: ProvisionResult, io: SeedIo): void {
  io.out('Tenant created.');
  io.out(`  Organisation: ${result.organization.name}`);
  io.out(`  Site: ${result.site.name} (${result.site.id})`);
  io.out('  Addresses:');
  result.hostnames.forEach((hostname, index) => {
    io.out(`    ${hostname}${index === 0 ? ' (primary)' : ''}`);
  });
  const { admin } = result;
  io.out(
    `  Admin: ${admin.email} (${admin.created ? 'new user' : 'existing user'})`,
  );
  if (admin.generatedPassword !== undefined) {
    io.out(
      `  Generated password (shown once, keep it safe): ${admin.generatedPassword}`,
    );
  }
}

/**
 * The message of an error, never its stack. A refused input keeps one line per problem; anything
 * else is squeezed onto one line.
 */
function messageOf(error: unknown): string {
  if (
    error instanceof ProvisionInputError ||
    error instanceof HostnameTakenError
  ) {
    return error.message;
  }
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.replace(/\s+/g, ' ').trim() || 'The tenant could not be created'
  );
}
