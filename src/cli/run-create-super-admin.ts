import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import {
  PlatformAdminService,
  type GrantResult,
} from '../platform-admin/platform-admin.service.js';
import { ProvisionInputError } from '../provisioning/tenant-input.js';
import { parseSuperAdminArgs } from './super-admin-args.js';

/** Where the command writes: one line per call. `err` is for everything that went wrong. */
export type SuperAdminIo = {
  out: (line: string) => void;
  err: (line: string) => void;
};

/** The running application, as far as the command needs it. `close` must be called exactly once. */
export type SuperAdminApp = {
  platformAdmin: PlatformAdminService;
  close: () => Promise<void>;
};

/** The real application without an HTTP server: the same `AppModule`, so the same environment as the API. */
async function openNestApp(): Promise<SuperAdminApp> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
    abortOnError: false,
  });
  return {
    platformAdmin: app.get(PlatformAdminService),
    close: () => app.close(),
  };
}

/**
 * The `create-super-admin` command, as a function: it returns the exit code (0, or 1 for anything
 * that went wrong) and writes only to `io`, so a test runs it without a terminal. Arguments are
 * checked before the application opens. Nothing here prints a supplied password or any hash; a
 * generated one is printed once.
 */
export async function runCreateSuperAdmin(
  argv: string[],
  env: Record<string, string | undefined>,
  io: SuperAdminIo,
  openApp: () => Promise<SuperAdminApp> = openNestApp,
): Promise<number> {
  const args = parseSuperAdminArgs(argv, env);
  if (!args.ok) {
    io.err(args.message);
    return 1;
  }

  let app: SuperAdminApp;
  try {
    app = await openApp();
  } catch (error) {
    io.err(messageOf(error));
    return 1;
  }

  let exitCode = 1;
  try {
    if (args.action === 'revoke') {
      const { email } = await app.platformAdmin.revoke(args.input);
      io.out(`${email} is no longer a super admin.`);
    } else {
      report(await app.platformAdmin.grant(args.input), io);
    }
    exitCode = 0;
  } catch (error) {
    io.err(messageOf(error));
  }

  try {
    await app.close();
  } catch (error) {
    io.err(`The application did not close cleanly: ${messageOf(error)}`);
  }
  return exitCode;
}

function report(result: GrantResult, io: SuperAdminIo): void {
  io.out(
    `${result.email} is a super admin (${result.created ? 'new account' : 'existing account'}).`,
  );
  if (result.generatedPassword !== undefined) {
    io.out(
      `  Generated password (shown once, keep it safe): ${result.generatedPassword}`,
    );
  }
}

/** The message of an error, never its stack, on one line. */
function messageOf(error: unknown): string {
  if (error instanceof ProvisionInputError) return error.message;
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').trim() || 'The command failed';
}
