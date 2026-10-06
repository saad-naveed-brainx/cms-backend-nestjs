import { PasswordService } from '../src/auth/password.service.js';

/**
 * `PasswordService` (FND-05): scrypt hashes written as `scrypt$N$r$p$salt$key`. Tests pass cheap
 * settings (`CHEAP`) so a hash takes a millisecond; the one place the production defaults are
 * needed (what `hash` uses with no settings, and the work `verifyAgainstDummy` does) pays for them
 * once or twice.
 */

const CHEAP = { N: 1024, r: 8, p: 1 };
const PASSWORD = 'correct horse battery staple';

describe('PasswordService', () => {
  const passwords = new PasswordService();

  it('[UC-AU-18] hashes with a random salt, then verifies the right password and no other', async () => {
    const first = await passwords.hash(PASSWORD, CHEAP);
    const second = await passwords.hash(PASSWORD, CHEAP);

    // Same password, two hashes: the salt is random.
    expect(first).not.toBe(second);
    for (const hash of [first, second]) {
      const parts = hash.split('$');
      expect(parts, hash).toHaveLength(6);
      const [scheme, N, r, p, salt, key] = parts;
      expect([scheme, N, r, p], hash).toEqual(['scrypt', '1024', '8', '1']);
      expect(salt, hash).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(key, hash).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(Buffer.from(salt, 'base64url'), hash).toHaveLength(16);
      expect(Buffer.from(key, 'base64url'), hash).toHaveLength(64);
    }
    expect(first.split('$')[4]).not.toBe(second.split('$')[4]);

    // The settings come from the call: none given means the defaults, a few given are merged in.
    expect(await passwords.hash('x')).toMatch(/^scrypt\$32768\$8\$3\$/);
    expect(await passwords.hash('x', { N: 2048 })).toMatch(
      /^scrypt\$2048\$8\$3\$/,
    );

    // The right password verifies and others do not: wrong, empty, and one that differs by a space.
    expect(await passwords.verify(PASSWORD, first)).toBe(true);
    expect(await passwords.verify(PASSWORD, second)).toBe(true);
    expect(await passwords.verify('not the password', first)).toBe(false);
    expect(await passwords.verify('', first)).toBe(false);
    expect(await passwords.verify(`${PASSWORD} `, first)).toBe(false);

    // Unicode and the longest allowed password round-trip, and do not verify as anything else.
    for (const [what, plain] of [
      ['unicode', 'pässwörd 🔐'],
      ['256 characters', 'p'.repeat(256)],
    ] as const) {
      const hash = await passwords.hash(plain, CHEAP);
      expect(await passwords.verify(plain, hash), what).toBe(true);
      expect(await passwords.verify(`${plain}x`, hash), what).toBe(false);
      expect(await passwords.verify(plain.slice(1), hash), what).toBe(false);
    }

    // The settings are read from the stored value, not from this instance: a hash made with other
    // settings still verifies.
    const other = await passwords.hash(PASSWORD, { N: 2048, r: 8, p: 2 });
    expect(await new PasswordService().verify(PASSWORD, other)).toBe(true);
  });

  it('[UC-AU-18] verify says false, and never throws, for a stored value that is not one of its hashes', async () => {
    const good = await passwords.hash(PASSWORD, CHEAP);
    const [scheme, N, r, p, salt, key] = good.split('$');
    const join = (...parts: (string | number)[]) => parts.join('$');

    // Control: the pieces below are cut from a hash that does verify.
    expect(await passwords.verify(PASSWORD, good)).toBe(true);

    const malformed: [string, string][] = [
      ['an empty string', ''],
      ['not-a-hash', 'not-a-hash'],
      ['the scheme alone', 'scrypt'],
      ['another scheme', join('bcrypt', N, r, p, salt, key)],
      [
        'a bcrypt-looking string',
        '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy',
      ],
      ['cut off after the scheme and N', join(scheme, N)],
      ['cut off after the settings', join(scheme, N, r, p)],
      ['cut off after the salt', join(scheme, N, r, p, salt)],
      ['an empty key', join(scheme, N, r, p, salt, '')],
      ['an empty salt', join(scheme, N, r, p, '', key)],
      ['a key cut short', join(scheme, N, r, p, salt, key.slice(0, 20))],
      ['a salt cut short', join(scheme, N, r, p, salt.slice(0, 5), key)],
      ['N that is not a number', join(scheme, 'abc', r, p, salt, key)],
      ['N that is not a whole number', join(scheme, '1024.5', r, p, salt, key)],
      ['N that is not a power of two', join(scheme, 1000, r, p, salt, key)],
      ['N of zero', join(scheme, 0, r, p, salt, key)],
      ['a negative N', join(scheme, -1024, r, p, salt, key)],
      ['N above the limit (2**21)', join(scheme, 2 ** 21, r, p, salt, key)],
      ['an astronomical N (2**40)', join(scheme, 2 ** 40, r, p, salt, key)],
      ['r of zero', join(scheme, N, 0, p, salt, key)],
      ['an astronomical r', join(scheme, N, 1_000_000, p, salt, key)],
      ['p of zero', join(scheme, N, r, 0, salt, key)],
      ['an astronomical p', join(scheme, N, r, 1_000_000, salt, key)],
    ];
    for (const [what, stored] of malformed) {
      await expect(passwords.verify(PASSWORD, stored), what).resolves.toBe(
        false,
      );
    }
  });

  it('[UC-AU-06] verifyAgainstDummy does real hashing work and hands back nothing', async () => {
    // The login step calls it for an unknown email, so that case costs as much as a wrong password.
    // A no-op would pass every other test; a floor of 10 ms catches it, and a dummy hash made with
    // cheap settings. A real default-cost scrypt takes well over that on any machine.
    for (const plain of ['whatever', 'p'.repeat(256)]) {
      const started = performance.now();
      await expect(
        passwords.verifyAgainstDummy(plain),
      ).resolves.toBeUndefined();
      expect(
        performance.now() - started,
        `${plain.length} characters`,
      ).toBeGreaterThan(10);
    }
  });
});
