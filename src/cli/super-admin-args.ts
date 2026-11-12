import { parseArgs } from 'node:util';

/** Shown after every argument problem. Placeholders only: no real-looking name, address or email. */
export const SUPER_ADMIN_USAGE = [
  'Usage: npm run create-super-admin -- --email <email> [--name <name>]',
  '       npm run create-super-admin -- --email <email> --revoke',
  '',
  'Makes someone the platform administrator (the super admin): they create, suspend and delete',
  'organisations and change their owners, and see nothing inside them.',
  '',
  '  --email   the account to make a super admin',
  '  --name    the name for a NEW account (omit it for an existing one, which keeps its name)',
  '  --revoke  take the super admin power away from the account instead',
  '',
  'A new account gets its password from the SUPER_ADMIN_PASSWORD environment variable (12 or more',
  'characters), or a generated one printed once. An existing account keeps its password.',
].join('\n');

export type SuperAdminArgs =
  | { ok: true; action: 'grant'; input: unknown }
  | { ok: true; action: 'revoke'; input: unknown }
  | { ok: false; message: string };

const PASSWORD_ADVICE =
  'The --password flag is not accepted: a password on the command line is kept in the shell ' +
  'history and shown in the list of running programs. Set the SUPER_ADMIN_PASSWORD environment ' +
  'variable instead.';

function refuse(problems: string[]): SuperAdminArgs {
  return {
    ok: false,
    message: `${problems.join('\n')}\n\n${SUPER_ADMIN_USAGE}`,
  };
}

/**
 * Reads the command line of `create-super-admin`. Only presence and combination are checked here;
 * what the values may be is the service's job. The password is never read from the command line: it
 * comes from `env.SUPER_ADMIN_PASSWORD` when that is set and not empty. `argv` and `env` are passed
 * in, so a test controls both.
 */
export function parseSuperAdminArgs(
  argv: string[],
  env: Record<string, string | undefined>,
): SuperAdminArgs {
  if (
    argv.some((arg) => arg === '--password' || arg.startsWith('--password='))
  ) {
    return refuse([PASSWORD_ADVICE]);
  }

  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        email: { type: 'string', multiple: true },
        name: { type: 'string', multiple: true },
        revoke: { type: 'boolean' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return refuse([message.replace(/\s+/g, ' ').trim()]);
  }

  const problems: string[] = [];
  if ((values.email ?? []).length === 0)
    problems.push('Missing required option: --email');
  if ((values.email ?? []).length > 1)
    problems.push('--email was repeated: give it only once');
  if ((values.name ?? []).length > 1)
    problems.push('--name was repeated: give it only once');
  if (values.revoke && (values.name ?? []).length > 0) {
    problems.push('--revoke takes only --email');
  }
  if (problems.length > 0) return refuse(problems);

  const email = values.email?.[0];
  if (values.revoke) return { ok: true, action: 'revoke', input: { email } };

  const password = env.SUPER_ADMIN_PASSWORD;
  return {
    ok: true,
    action: 'grant',
    input: {
      email,
      ...(values.name?.[0] === undefined ? {} : { name: values.name[0] }),
      ...(password ? { password } : {}),
    },
  };
}
