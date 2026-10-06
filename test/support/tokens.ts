import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';

/**
 * Tokens built by hand with `jose`, so the guard tests do not depend on the code that issues
 * tokens, and so a bad token can be bad in exactly one way (FND-05, UC-AU-08).
 */

const utf8 = new TextEncoder();

/** The secret the app under test signs and checks with: the vitest configs set `JWT_SECRET`. */
export function appSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error(
      'JWT_SECRET is not set in the test environment (vitest.config.ts and vitest.config.e2e.ts set it)',
    );
  }
  return utf8.encode(secret);
}

/** A key the app has never heard of, as long as a real one. */
export const OTHER_SECRET = utf8.encode(
  'a-different-secret-that-is-just-as-long-as-the-real-one',
);

const nowInSeconds = () => Math.floor(Date.now() / 1000);

/** The three claims a token carries, in seconds since 1970 for the two times. */
type Claims = { sub?: string; iat?: number; exp?: number };

type SigningOptions = {
  secret?: Uint8Array;
  alg?: 'HS256' | 'HS384' | 'HS512';
};

/**
 * A correctly signed token. With no arguments it names no one and lives for an hour; pass the
 * claims or the key to bend it. `sub` is left out of the token when not given.
 */
export async function signTestToken(
  claims: Claims = {},
  { secret = appSecret(), alg = 'HS256' }: SigningOptions = {},
): Promise<string> {
  const issuedAt = claims.iat ?? nowInSeconds();
  const jwt = new SignJWT({})
    .setProtectedHeader({ alg })
    .setIssuedAt(issuedAt)
    .setExpirationTime(claims.exp ?? issuedAt + 3600);
  if (claims.sub !== undefined) jwt.setSubject(claims.sub);
  return jwt.sign(secret);
}

const toBase64Url = (value: object) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

/**
 * Tokens the app must refuse, each wrong in one way only. `secret` is the key a good token would be
 * signed with (the app's own unless a unit test gives its own). Nothing here is an empty string:
 * that is a case about the header, not about the token.
 */
export async function badTokens(
  userId: string,
  secret: Uint8Array = appSecret(),
): Promise<{ what: string; token: string }[]> {
  const now = nowInSeconds();
  const good = await signTestToken({ sub: userId }, { secret });

  // The payload changed after signing: same header, same signature, another (valid) user.
  const [header, payload, signature] = good.split('.');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
  const edited = `${header}.${toBase64Url({ ...claims, sub: randomUUID() })}.${signature}`;

  // `alg: none` built by hand: an unsigned token whose claims are all fine.
  const unsigned = `${toBase64Url({ alg: 'none', typ: 'JWT' })}.${toBase64Url({ sub: userId, iat: now, exp: now + 3600 })}.`;

  return [
    { what: 'plain garbage', token: 'garbage' },
    { what: 'three dot-separated words', token: 'a.b.c' },
    {
      what: 'a token signed by a different secret',
      token: await signTestToken({ sub: userId }, { secret: OTHER_SECRET }),
    },
    {
      what: 'a token signed with HS512 by the right secret',
      token: await signTestToken({ sub: userId }, { secret, alg: 'HS512' }),
    },
    {
      what: 'an expired token',
      token: await signTestToken(
        { sub: userId, iat: now - 7200, exp: now - 3600 },
        { secret },
      ),
    },
    { what: 'an alg none token', token: unsigned },
    { what: 'a token with no sub', token: await signTestToken({}, { secret }) },
    {
      what: 'a token whose sub is not a uuid',
      token: await signTestToken({ sub: 'not-a-uuid' }, { secret }),
    },
    { what: 'a token whose payload was edited after signing', token: edited },
  ];
}
