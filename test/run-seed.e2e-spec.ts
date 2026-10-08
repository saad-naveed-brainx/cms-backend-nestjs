import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { PasswordService } from '../src/auth/password.service.js';
import { runSeed } from '../src/cli/run-seed.js';
import { Site, User } from '../src/database/entities/index.js';
import { ProvisioningService } from '../src/provisioning/provisioning.service.js';
import { createTestApp } from './support/app.js';
import { resetDatabase } from './support/database.js';
import { noRows, recordingIo, rowCounts } from './support/tenant.js';

/**
 * Running the seed command (FND-06) end to end: `runSeed` with a fake output, the real
 * `ProvisioningService` and the real test database. Its `close` is a counter, because the app is
 * shared by every test in the file; the real closing is checked in run-seed.spec.ts.
 *
 * The command's output is not spelled out by the use case, so these tests read it the way a
 * person would: the ids, names and addresses are somewhere in it, a marker such as "(primary)" sits
 * right after the thing it describes, and the generated password is found by the one test that
 * counts: it is the 24-character word that opens the admin's stored hash.
 */

// Production-cost scrypt takes about 0.2 s a hash, and a test here hashes and verifies a few times.
vi.setConfig({ testTimeout: 30_000 });

type Flags = {
  organization: string;
  site: string;
  hosts: string[];
  email: string;
  name: string;
};

const argvFor = ({
  organization,
  site,
  hosts,
  email,
  name,
}: Flags): string[] => [
  '--organization',
  organization,
  '--site',
  site,
  ...hosts.flatMap((host) => ['--host', host]),
  '--email',
  email,
  '--name',
  name,
];

const GEN: Flags = {
  organization: 'Gen Holdings',
  site: 'Gen Bakery',
  hosts: ['Gen.Test', 'www.gen.test'],
  email: 'Gina@Gen.TEST',
  name: 'Gina Gen',
};

const MAPLE: Flags = {
  organization: 'Maple Holdings',
  site: 'Maple Bakery',
  hosts: ['maple.test'],
  email: 'mira@maple.test',
  name: 'Mira Maple',
};

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `value` as a whole word with `marker` straight after it, a few separator characters between. */
function marked(text: string, value: string, marker: string): boolean {
  return new RegExp(
    `(?<![\\w.@-])${escaped(value)}(?![\\w.@-])\\W{0,4}${escaped(marker)}`,
  ).test(text);
}

describe('runSeed against the real app and database', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  const passwords = new PasswordService();

  beforeAll(async () => {
    ({ app, dataSource } = await createTestApp());
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
  });

  afterAll(async () => {
    await app.close();
  });

  /** One run of the command: its exit code, both streams, and how often the app was opened and closed. */
  const run = async (
    argv: string[],
    env: Record<string, string | undefined> = {},
  ) => {
    const { io, out, err } = recordingIo();
    let opened = 0;
    let closed = 0;
    const code = await runSeed(argv, env, io, async () => {
      opened += 1;
      return {
        provisioning: app.get(ProvisioningService),
        close: async () => {
          closed += 1;
        },
      };
    });
    return { code, out, err, opened, closed };
  };

  const printed = (ran: { out: string[]; err: string[] }) =>
    [...ran.out, ...ran.err].join('\n');

  /** The password the command printed: the 24-character word of the text that opens `hash`. */
  async function printedPassword(
    text: string,
    hash: string,
  ): Promise<string | undefined> {
    const words = new Set(
      text.split(/[^A-Za-z0-9_-]+/).filter((word) => word.length === 24),
    );
    for (const word of words) {
      if (await passwords.verify(word, hash)) return word;
    }
    return undefined;
  }

  it('[UC-TS-11] a run with no password in the environment creates the tenant, reports it, and shows the generated password once', async () => {
    const first = await run(argvFor(GEN));

    expect(first.code).toBe(0);
    expect(first.err).toEqual([]);
    const [site] = await dataSource.getRepository(Site).find();
    const [admin] = await dataSource.getRepository(User).find();
    expect(admin.email).toBe('gina@gen.test');
    const text = first.out.join('\n');

    // What was created: the site's id and name, both addresses as the tidied ones with only the
    // first marked primary, and the admin's email with a note that the user is new.
    expect(text).toContain(site.id);
    expect(text).toContain('Gen Bakery');
    expect(marked(text, 'gen.test', '(primary)')).toBe(true);
    expect(text).toContain('www.gen.test');
    expect(text.match(/\(primary\)/g)).toHaveLength(1);
    expect(marked(text, 'gina@gen.test', '(new user)')).toBe(true);

    // The generated password is in the output once, and the hash it opens is nowhere in it.
    const password = await printedPassword(text, admin.passwordHash);
    expect(
      password,
      'a 24-character word in the output that opens the stored hash',
    ).toBeDefined();
    expect(text.split(password as string)).toHaveLength(2);
    expect(text).not.toContain(admin.passwordHash);
    expect(text).not.toMatch(/scrypt/);

    // The same person again, on another site: an existing user, and no password to show.
    const again = await run(
      argvFor({
        ...GEN,
        organization: 'Second Holdings',
        site: 'Gen Second',
        hosts: ['second.gen.test'],
      }),
    );
    expect(again.code).toBe(0);
    const againText = again.out.join('\n');
    expect(marked(againText, 'gina@gen.test', '(existing user)')).toBe(true);
    expect(againText).not.toContain('(new user)');
    expect(await printedPassword(againText, admin.passwordHash)).toBe(
      undefined,
    );
    expect(againText).not.toContain(admin.passwordHash);
  });

  it('[UC-TS-11] a run with a password in the environment uses it, says the user is new, and prints neither the password nor any hash', async () => {
    const password = 'env supplied pass 7';

    const ran = await run(argvFor(MAPLE), { SEED_ADMIN_PASSWORD: password });

    expect(ran.code).toBe(0);
    expect(ran.err).toEqual([]);
    const [admin] = await dataSource.getRepository(User).find();
    expect(await passwords.verify(password, admin.passwordHash)).toBe(true);
    const text = printed(ran);
    expect(marked(text, 'mira@maple.test', '(new user)')).toBe(true);
    expect(text).not.toContain(password);
    expect(text).not.toContain(admin.passwordHash);
    expect(text).not.toMatch(/scrypt/);
  });

  it('[UC-TS-11] a bad command, a rejected input or a taken address ends in code 1 with a message on the error stream, creates nothing, and prints no password', async () => {
    // Arguments it refuses are refused before the app is opened.
    const noArguments = await run([]);
    expect(noArguments.code).toBe(1);
    expect(noArguments.err.length).toBeGreaterThan(0);
    expect(noArguments.opened).toBe(0);

    const typed = 'typed-on-the-command-line';
    const withFlag = await run([...argvFor(MAPLE), '--password', typed]);
    expect(withFlag.code).toBe(1);
    expect(withFlag.err.join('\n')).toContain('SEED_ADMIN_PASSWORD');
    expect(withFlag.opened).toBe(0);
    expect(printed(withFlag)).not.toContain(typed);

    // An input the service refuses: a password of 11 characters, supplied by the environment.
    const tooShort = 'elevenchars';
    const refused = await run(argvFor(MAPLE), {
      SEED_ADMIN_PASSWORD: tooShort,
    });
    expect(refused.code).toBe(1);
    expect(refused.err.join('\n')).toMatch(/password/i);
    expect(printed(refused)).not.toContain(tooShort);
    expect({ opened: refused.opened, closed: refused.closed }).toEqual({
      opened: 1,
      closed: 1,
    });
    expect(await rowCounts(dataSource)).toEqual(noRows(dataSource));

    // A taken address: the first tenant owns `taken.test`; the second lists it after `new.test`.
    const owner = await run(argvFor({ ...MAPLE, hosts: ['taken.test'] }), {
      SEED_ADMIN_PASSWORD: 'first tenant password',
    });
    expect(owner.code).toBe(0);
    const before = await rowCounts(dataSource);

    const secondPassword = 'second tenant password';
    const taken = await run(
      argvFor({
        organization: 'Second Holdings',
        site: 'Second Shop',
        hosts: ['new.test', 'TAKEN.test'],
        email: 'sam@second.test',
        name: 'Sam Second',
      }),
      { SEED_ADMIN_PASSWORD: secondPassword },
    );
    expect(taken.code).toBe(1);
    expect(taken.err.join('\n')).toContain('taken.test');
    expect(printed(taken)).not.toContain(secondPassword);
    expect(printed(taken)).not.toMatch(/scrypt/);
    expect({ opened: taken.opened, closed: taken.closed }).toEqual({
      opened: 1,
      closed: 1,
    });
    expect(await rowCounts(dataSource)).toEqual(before);
  });
});
