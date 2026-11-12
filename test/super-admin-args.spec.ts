import { parseSuperAdminArgs } from '../src/cli/super-admin-args.js';

describe('the create-super-admin command line', () => {
  it('[UC-PA-01] reads an email and a name, and the password only from the environment', () => {
    expect(
      parseSuperAdminArgs(['--email', 'ops@platform.test', '--name', 'Ops'], {
        SUPER_ADMIN_PASSWORD: 'a-long-enough-password',
      }),
    ).toEqual({
      ok: true,
      action: 'grant',
      input: {
        email: 'ops@platform.test',
        name: 'Ops',
        password: 'a-long-enough-password',
      },
    });
  });

  it('[UC-PA-02] an email alone is enough (an existing account)', () => {
    expect(parseSuperAdminArgs(['--email', 'hal@demo.test'], {})).toEqual({
      ok: true,
      action: 'grant',
      input: { email: 'hal@demo.test' },
    });
  });

  it('[UC-PA-27] --revoke takes only an email', () => {
    expect(
      parseSuperAdminArgs(['--email', 'a@b.test', '--revoke'], {}),
    ).toEqual({
      ok: true,
      action: 'revoke',
      input: { email: 'a@b.test' },
    });
    const withName = parseSuperAdminArgs(
      ['--email', 'a@b.test', '--name', 'A', '--revoke'],
      {},
    );
    expect(withName.ok).toBe(false);
  });

  it('refuses a missing email, a repeated flag, an unknown flag and any --password', () => {
    for (const argv of [
      [],
      ['--email', 'a@b.test', '--email', 'c@d.test'],
      ['--email', 'a@b.test', '--nope'],
      ['--email', 'a@b.test', '--password', 'hunter2hunter2'],
      ['--email', 'a@b.test', '--password=hunter2hunter2'],
    ]) {
      const result = parseSuperAdminArgs(argv, {});
      expect(result.ok, argv.join(' ')).toBe(false);
    }
  });
});
