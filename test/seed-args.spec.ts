import { parseSeedArgs, USAGE } from '../src/cli/seed-args.js';

/**
 * The seed command's arguments (FND-06): five flags and one environment variable, read from what
 * the caller hands in. A failure is a value, not an exception, and says what is wrong and how to
 * call the command. The password never travels on the command line, where `ps` and shell history
 * would keep it.
 */

// The first address is the primary one, so the order is not alphabetical on purpose: a parser that
// sorted its hosts would show.
const PAIRS: [string, string][] = [
  ['--organization', 'Maple Holdings'],
  ['--site', 'Maple Bakery'],
  ['--host', 'shop.maple.test'],
  ['--host', 'maple.test'],
  ['--email', 'mira@maple.test'],
  ['--name', 'Mira Maple'],
];
const FULL = PAIRS.flat();
const WITHOUT = (flag: string) =>
  PAIRS.filter(([name]) => name !== flag).flat();

const EXPECTED = {
  organizationName: 'Maple Holdings',
  siteName: 'Maple Bakery',
  hostnames: ['shop.maple.test', 'maple.test'],
  admin: { email: 'mira@maple.test', name: 'Mira Maple' },
};

const TYPED_PASSWORD = 'typed-on-the-command-line';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('parseSeedArgs', () => {
  it('[UC-TS-10] parses the full flag set, takes the password from the given environment only, and refuses every mistake with the problem and the usage', () => {
    // The usage is what a person reads after a mistake: it lists every flag and the variable.
    for (const word of [
      '--organization',
      '--site',
      '--host',
      '--email',
      '--name',
      'SEED_ADMIN_PASSWORD',
    ]) {
      expect(USAGE, `the usage mentions ${word}`).toContain(word);
    }

    // The full set, with its two --host in the order given.
    expect(parseSeedArgs(FULL, {})).toEqual({ ok: true, input: EXPECTED });

    // The same with a password in the environment.
    expect(
      parseSeedArgs(FULL, { SEED_ADMIN_PASSWORD: 'maple environment pass' }),
    ).toEqual({
      ok: true,
      input: {
        ...EXPECTED,
        admin: { ...EXPECTED.admin, password: 'maple environment pass' },
      },
    });

    // Nothing is read from the real process environment: a password set there is not picked up.
    vi.stubEnv('SEED_ADMIN_PASSWORD', 'a password in the real environment');
    const unread = parseSeedArgs(FULL, {});
    expect(unread).toEqual({ ok: true, input: EXPECTED });
    expect(JSON.stringify(unread)).not.toContain('real environment');

    // Every other case is a failure that names the problem (apart from the usage) and shows the usage.
    const refusals: { what: string; argv: string[]; names: RegExp }[] = [
      { what: 'no arguments at all', argv: [], names: /\S/ },
      {
        what: 'no --organization',
        argv: WITHOUT('--organization'),
        names: /--organization/,
      },
      { what: 'no --site', argv: WITHOUT('--site'), names: /--site/ },
      { what: 'no --host', argv: WITHOUT('--host'), names: /--host/ },
      { what: 'no --email', argv: WITHOUT('--email'), names: /--email/ },
      { what: 'no --name', argv: WITHOUT('--name'), names: /--name/ },
      {
        what: 'an unknown flag',
        argv: [...FULL, '--colour', 'red'],
        names: /colour/,
      },
      {
        what: 'a --password flag, which the environment variable is for',
        argv: [...FULL, '--password', TYPED_PASSWORD],
        names: /SEED_ADMIN_PASSWORD/,
      },
      {
        what: 'a --password=value flag',
        argv: [...FULL, `--password=${TYPED_PASSWORD}`],
        names: /SEED_ADMIN_PASSWORD/,
      },
      {
        what: '--host with no value',
        argv: [...WITHOUT('--host'), '--host'],
        names: /--host/,
      },
      {
        what: '--organization given twice',
        argv: [...FULL, '--organization', 'Another Holdings'],
        names: /--organization/,
      },
      {
        what: '--site given twice',
        argv: [...FULL, '--site', 'Another Bakery'],
        names: /--site/,
      },
      {
        what: '--email given twice',
        argv: [...FULL, '--email', 'other@maple.test'],
        names: /--email/,
      },
      {
        what: '--name given twice',
        argv: [...FULL, '--name', 'Another Name'],
        names: /--name/,
      },
      {
        what: 'a stray positional argument',
        argv: [...FULL, 'stray'],
        names: /stray|positional|unexpected|argument/i,
      },
    ];

    for (const { what, argv, names } of refusals) {
      const result = parseSeedArgs(argv, {});

      expect(result.ok, what).toBe(false);
      if (result.ok) continue;
      expect(result.message, `${what}: shows the usage`).toContain(USAGE);
      const problem = result.message.replace(USAGE, '');
      expect(problem, `${what}: names the problem`).toMatch(names);
      expect(result.message, `${what}: echoes no password`).not.toContain(
        TYPED_PASSWORD,
      );
    }
  });
});
