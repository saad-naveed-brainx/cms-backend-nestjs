import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SignJWT, jwtVerify } from 'jose';
import { isUuid } from '../database/scoped.repository.js';
import { readAuthConfig } from './auth-config.js';

const SECONDS_PER_UNIT: Record<string, number> = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86_400,
  w: 604_800,
  y: 31_557_600,
};

/** The units `jose` accepts for a length of time ("7d", "12 hours", "30 mins"), without a sign. */
const LIFETIME =
  /^(\d+(?:\.\d+)?) ?(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w|years?|yrs?|y)$/i;

/** A lifetime such as `7d` in seconds. Throws at start-up for a value that is not a length of time. */
function lifetimeInSeconds(expiresIn: string): number {
  const match = LIFETIME.exec(expiresIn.trim());
  const seconds = match
    ? Math.round(Number(match[1]) * SECONDS_PER_UNIT[match[2][0].toLowerCase()])
    : 0;
  if (!(seconds > 0)) {
    throw new Error(
      `JWT_EXPIRES_IN must be a length of time such as 7d, 12h or 30m (got "${expiresIn}")`,
    );
  }
  return seconds;
}

/**
 * Signs and checks login tokens: HS256, with the user's id as `sub` and the dates as `iat` and
 * `exp`, and nothing else (docs/DECISIONS.md D-018). What a user may do is looked up on each
 * request, never read from the token.
 */
@Injectable()
export class TokenService {
  private readonly key: Uint8Array;
  private readonly lifetimeSeconds: number;

  constructor(config: ConfigService) {
    const { secret, expiresIn } = readAuthConfig({
      JWT_SECRET: config.get<string>('JWT_SECRET'),
      JWT_EXPIRES_IN: config.get<string>('JWT_EXPIRES_IN'),
      NODE_ENV: config.get<string>('NODE_ENV'),
    });
    this.key = new TextEncoder().encode(secret);
    this.lifetimeSeconds = lifetimeInSeconds(expiresIn);
  }

  /** A token for this user. `iat` and `exp` come from one clock reading, so the lifetime is exact. */
  async sign(userId: string): Promise<{ token: string; expiresAt: Date }> {
    const issuedAt = Math.floor(Date.now() / 1000);
    const expiresAt = issuedAt + this.lifetimeSeconds;
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuedAt(issuedAt)
      .setExpirationTime(expiresAt)
      .sign(this.key);
    return { token, expiresAt: new Date(expiresAt * 1000) };
  }

  /**
   * The user a token names, or `null` for anything that is not a good token of ours: malformed,
   * wrongly signed, expired, signed with another algorithm (`none` included), or without an expiry
   * and a uuid for `sub`. Never throws.
   */
  async verify(token: string): Promise<{ userId: string } | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        algorithms: ['HS256'],
        requiredClaims: ['sub', 'exp'],
      });
      return isUuid(payload.sub) ? { userId: payload.sub } : null;
    } catch {
      return null;
    }
  }
}
