import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { decodeJwt, decodeProtectedHeader, jwtVerify } from 'jose';
import { TokenService } from '../src/auth/token.service.js';
import { badTokens } from './support/tokens.js';

/**
 * `TokenService` (FND-05): signs HS256 tokens that carry the user's id and two dates, and gives a
 * user id back only for a token it would have signed itself. Built with a real `ConfigService`
 * holding explicit values, so nothing depends on the environment of the test run.
 */

const SECRET = 'unit-test-secret-0123456789abcdef-0123456789';
const KEY = new TextEncoder().encode(SECRET);
const WEEK = 7 * 24 * 60 * 60;

/** The three settings the service reads. `JWT_EXPIRES_IN: ''` stands for "not set". */
function config(values: Record<string, string> = {}): ConfigService {
  return new ConfigService({
    JWT_SECRET: SECRET,
    JWT_EXPIRES_IN: '',
    NODE_ENV: 'test',
    ...values,
  });
}

describe('TokenService', () => {
  it('[UC-AU-10] signs HS256 with sub, iat and exp only, for the configured lifetime', async () => {
    const userId = randomUUID();
    const before = Date.now();
    const { token, expiresAt } = await new TokenService(config()).sign(userId);

    expect(decodeProtectedHeader(token).alg).toBe('HS256');
    const claims = decodeJwt(token);
    expect(Object.keys(claims).sort()).toEqual(['exp', 'iat', 'sub']);
    expect(claims.sub).toBe(userId);
    expect(claims.iat! * 1000).toBeGreaterThanOrEqual(before - 1000);
    expect(claims.iat! * 1000).toBeLessThanOrEqual(Date.now() + 1000);
    expect(claims.exp! - claims.iat!).toBe(WEEK);

    // `expiresAt` is the moment the token stops working, to the second.
    expect(expiresAt).toBeInstanceOf(Date);
    expect(
      Math.abs(expiresAt.getTime() - claims.exp! * 1000),
    ).toBeLessThanOrEqual(1000);

    // It is signed with the configured secret: an independent library accepts it.
    const verified = await jwtVerify(token, KEY, { algorithms: ['HS256'] });
    expect(verified.payload.sub).toBe(userId);

    // The lifetime follows JWT_EXPIRES_IN.
    const hour = await new TokenService(config({ JWT_EXPIRES_IN: '1h' })).sign(
      userId,
    );
    const hourClaims = decodeJwt(hour.token);
    expect(hourClaims.exp! - hourClaims.iat!).toBe(3600);
  });

  it('[UC-AU-08] gives back the user of its own token, and null for every token that is not good', async () => {
    const tokens = new TokenService(config());
    const userId = randomUUID();
    const { token } = await tokens.sign(userId);

    expect(await tokens.verify(token)).toEqual({ userId });

    const bad = [
      { what: 'an empty string', token: '' },
      ...(await badTokens(userId, KEY)),
    ];
    for (const { what, token: candidate } of bad) {
      await expect(tokens.verify(candidate), what).resolves.toBeNull();
    }

    // A token of ours is refused by a service configured with another secret.
    const elsewhere = new TokenService(
      config({ JWT_SECRET: 'another-secret-0123456789abcdef-0123456789' }),
    );
    expect(await elsewhere.verify(token)).toBeNull();
  });

  it('[UC-AU-19] takes the secret and the lifetime from the configuration, and cannot be built on a bad secret', () => {
    expect(() => new TokenService(config({ JWT_SECRET: '' }))).toThrow(
      /JWT_SECRET/,
    );
    expect(() => new TokenService(config())).not.toThrow();

    // The same strictness production gets from readAuthConfig, so the app refuses to start.
    const production = { NODE_ENV: 'production' };
    expect(
      () =>
        new TokenService(config({ ...production, JWT_SECRET: 'a'.repeat(31) })),
    ).toThrow(/secret/i);
    expect(
      () =>
        new TokenService(
          config({ ...production, JWT_SECRET: 'dev-only-change-me' }),
        ),
    ).toThrow(/secret/i);
    expect(
      () =>
        new TokenService(config({ ...production, JWT_SECRET: 'a'.repeat(32) })),
    ).not.toThrow();
  });
});
