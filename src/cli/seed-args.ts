import { parseArgs } from 'node:util';

/** Shown after every argument problem. Placeholders only: no real-looking name, address or email. */
export const USAGE = [
  'Usage: npm run seed -- --organization <name> --site <name> --host <address> [--host <address> ...] --email <email> --name <name>',
  '',
  'Creates a tenant: an organisation, a site with its web addresses, and the first administrator.',
  '',
  '  --organization  name of the client company',
  '  --site          name of the site',
  '  --host          a web address the site answers on; repeat it for more, the first is primary',
  "  --email         the administrator's email address",
  "  --name          the administrator's name",
  '',
  'The password comes from the SEED_ADMIN_PASSWORD environment variable (12 or more characters).',
  'Without it, a new administrator gets a generated password, printed once. An existing user keeps theirs.',
].join('\n');

export type SeedArgs =
  { ok: true; input: unknown } | { ok: false; message: string };

const PASSWORD_ADVICE =
  'The --password flag is not accepted: a password on the command line is kept in the shell ' +
  'history and shown in the list of running programs. Set the SEED_ADMIN_PASSWORD environment ' +
  'variable instead.';

/** The flags, in the order the usage line shows them. All are required; only `host` may repeat. */
const FLAGS = ['organization', 'site', 'host', 'email', 'name'] as const;

function isPasswordFlag(arg: string): boolean {
  return arg === '--password' || arg.startsWith('--password=');
}

function refuse(problems: string[]): SeedArgs {
  return { ok: false, message: `${problems.join('\n')}\n\n${USAGE}` };
}

/**
 * Reads the command line of the seed command into the shape `ProvisioningService` takes. Only
 * presence is checked here (every flag given, none repeated but `--host`); what the values may be
 * is the service's job.
 *
 * The password never comes from the command line, so it cannot end up in the shell history or in
 * the process list: it is read from `env.SEED_ADMIN_PASSWORD` when that is set and not empty.
 * `argv` and `env` are passed in, never read from `process` here, so a test controls both.
 */
export function parseSeedArgs(
  argv: string[],
  env: Record<string, string | undefined>,
): SeedArgs {
  if (argv.some(isPasswordFlag)) return refuse([PASSWORD_ADVICE]);

  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        organization: { type: 'string', multiple: true },
        site: { type: 'string', multiple: true },
        host: { type: 'string', multiple: true },
        email: { type: 'string', multiple: true },
        name: { type: 'string', multiple: true },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    // Node words these well (unknown flag, flag without a value, stray argument); some span lines.
    const message = error instanceof Error ? error.message : String(error);
    return refuse([message.replace(/\s+/g, ' ').trim()]);
  }

  const problems: string[] = [];
  for (const flag of FLAGS) {
    const given = values[flag] ?? [];
    if (given.length === 0) {
      problems.push(`Missing required option: --${flag}`);
    } else if (given.length > 1 && flag !== 'host') {
      problems.push(`--${flag} was repeated: give it only once`);
    }
  }
  if (problems.length > 0) return refuse(problems);

  const password = env.SEED_ADMIN_PASSWORD;
  return {
    ok: true,
    input: {
      organizationName: values.organization?.[0],
      siteName: values.site?.[0],
      hostnames: values.host,
      admin: {
        email: values.email?.[0],
        name: values.name?.[0],
        ...(password ? { password } : {}),
      },
    },
  };
}
