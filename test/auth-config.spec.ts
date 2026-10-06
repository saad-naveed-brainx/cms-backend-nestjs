import { readAuthConfig } from '../src/auth/auth-config.js';

/**
 * `readAuthConfig` (FND-05): turns the environment into the signing secret and the token lifetime,
 * and refuses to start the app on a secret that is missing, or too weak for production. It reads
 * only the environment it is given, never `process.env` (this process runs with `NODE_ENV=test`).
 */

const DEV_DEFAULT = 'dev-only-change-me'; // what .env.example ships
const SECRET_31 = 'a'.repeat(31);
const SECRET_32 = 'b'.repeat(32);

describe('readAuthConfig', () => {
  it('[UC-AU-19] refuses a missing or empty secret, and in production a default or short one', () => {
    const refused: [string, Record<string, string | undefined>, RegExp][] = [
      ['no secret', { NODE_ENV: 'development' }, /JWT_SECRET/],
      [
        'an empty secret',
        { JWT_SECRET: '', NODE_ENV: 'development' },
        /JWT_SECRET/,
      ],
      ['no secret, no NODE_ENV', {}, /JWT_SECRET/],
      ['no secret in production', { NODE_ENV: 'production' }, /JWT_SECRET/],
      [
        'an empty secret in production',
        { JWT_SECRET: '', NODE_ENV: 'production' },
        /JWT_SECRET/,
      ],
      [
        'the dev default in production',
        { JWT_SECRET: DEV_DEFAULT, NODE_ENV: 'production' },
        /secret/i,
      ],
      [
        '31 characters in production',
        { JWT_SECRET: SECRET_31, NODE_ENV: 'production' },
        /secret/i,
      ],
    ];
    for (const [what, env, message] of refused) {
      expect(() => readAuthConfig(env), what).toThrow(message);
    }

    const accepted: [string, Record<string, string | undefined>][] = [
      [
        '10 characters in development',
        { JWT_SECRET: 'abcdefghij', NODE_ENV: 'development' },
      ],
      ['10 characters in test', { JWT_SECRET: 'abcdefghij', NODE_ENV: 'test' }],
      ['10 characters with NODE_ENV unset', { JWT_SECRET: 'abcdefghij' }],
      [
        'the dev default in development',
        { JWT_SECRET: DEV_DEFAULT, NODE_ENV: 'development' },
      ],
      [
        '32 characters in production',
        { JWT_SECRET: SECRET_32, NODE_ENV: 'production' },
      ],
    ];
    for (const [what, env] of accepted) {
      expect(readAuthConfig(env), what).toEqual({
        secret: env.JWT_SECRET,
        expiresIn: '7d',
      });
    }
  });

  it('[UC-AU-19] the token lifetime is 7d unless JWT_EXPIRES_IN says otherwise', () => {
    const secret = SECRET_32;
    const lifetimes: [string, string | undefined, string][] = [
      ['JWT_EXPIRES_IN not set', undefined, '7d'],
      ['JWT_EXPIRES_IN empty', '', '7d'],
      ['JWT_EXPIRES_IN set to 1h', '1h', '1h'],
      ['JWT_EXPIRES_IN set to 30d', '30d', '30d'],
    ];
    for (const [what, JWT_EXPIRES_IN, expected] of lifetimes) {
      for (const NODE_ENV of ['development', 'production']) {
        expect(
          readAuthConfig({ JWT_SECRET: secret, JWT_EXPIRES_IN, NODE_ENV }),
          `${what} in ${NODE_ENV}`,
        ).toEqual({ secret, expiresIn: expected });
      }
    }
  });
});
