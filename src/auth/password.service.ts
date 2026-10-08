import {
  randomBytes,
  scrypt,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';
import { promisify } from 'node:util';
import { Injectable } from '@nestjs/common';

export type ScryptParams = { N: number; r: number; p: number };

/** N = 2^15, r = 8, p = 3: an OWASP-listed setting. Tests pass a cheaper one. */
const DEFAULT_PARAMS: ScryptParams = { N: 32_768, r: 8, p: 3 };

const SALT_BYTES = 16;
const KEY_BYTES = 64;

/**
 * Node refuses scrypt work above `maxmem` (32 MiB by default), and the default setting needs a
 * little more than that. 256 MiB is far above any setting we use and still a hard ceiling.
 */
const MAX_MEMORY = 256 * 1024 * 1024;

/** What a stored hash may ask of us. Anything beyond is not a hash we wrote, so it never runs. */
const MAX_N = 2 ** 20;
const MAX_R = 32;
const MAX_P = 16;

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keyLength: number,
  options: ScryptOptions,
) => Promise<Buffer>;

function deriveKey(
  plain: string,
  salt: Buffer,
  keyLength: number,
  { N, r, p }: ScryptParams,
): Promise<Buffer> {
  return scryptAsync(plain, salt, keyLength, { N, r, p, maxmem: MAX_MEMORY });
}

/** A whole number written in plain digits, up to 10 of them: no sign, no exponent, no spaces. */
function wholeNumber(text: string): number {
  return /^[1-9][0-9]{0,9}$/.test(text) ? Number(text) : NaN;
}

/** Within what scrypt accepts (N a power of two, at least 2) and what we are willing to run. */
function isSaneParams({ N, r, p }: ScryptParams): boolean {
  return (
    Number.isInteger(N) &&
    N >= 2 &&
    N <= MAX_N &&
    (N & (N - 1)) === 0 &&
    Number.isInteger(r) &&
    r >= 1 &&
    r <= MAX_R &&
    Number.isInteger(p) &&
    p >= 1 &&
    p <= MAX_P
  );
}

/** The bytes behind a base64url string, only when it is written exactly the way `hash` writes it. */
function decodeCanonical(text: string, length: number): Buffer | null {
  const bytes = Buffer.from(text, 'base64url');
  return bytes.length === length && bytes.toString('base64url') === text
    ? bytes
    : null;
}

type StoredHash = { params: ScryptParams; salt: Buffer; key: Buffer };

/** `scrypt$N$r$p$salt$key`, or `null` for anything else. Never throws. */
function parseStoredHash(stored: unknown): StoredHash | null {
  if (typeof stored !== 'string') return null;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;

  const params = {
    N: wholeNumber(parts[1]),
    r: wholeNumber(parts[2]),
    p: wholeNumber(parts[3]),
  };
  if (!isSaneParams(params)) return null;

  const salt = decodeCanonical(parts[4], SALT_BYTES);
  const key = decodeCanonical(parts[5], KEY_BYTES);
  return salt && key ? { params, salt, key } : null;
}

/**
 * Passwords are stored as `scrypt$N$r$p$salt$key` (salt and key in base64url). The settings sit in
 * the string, so they can change later and old hashes still check. Node's own scrypt, not argon2
 * or bcrypt, so there is no native dependency to build (docs/DECISIONS.md D-018).
 */
@Injectable()
export class PasswordService {
  /** One valid hash for `verifyAgainstDummy`, made on first use and shared after. */
  private dummyHash: Promise<string> | undefined;

  async hash(
    plain: string,
    params: Partial<ScryptParams> = {},
  ): Promise<string> {
    const settings = { ...DEFAULT_PARAMS, ...params };
    const salt = randomBytes(SALT_BYTES);
    const key = await deriveKey(plain, salt, KEY_BYTES, settings);
    return [
      'scrypt',
      settings.N,
      settings.r,
      settings.p,
      salt.toString('base64url'),
      key.toString('base64url'),
    ].join('$');
  }

  /**
   * Whether `plain` is the password behind `stored`. `false`, never an error, for a stored value
   * that is not one of our hashes or asks for absurd work.
   */
  async verify(plain: string, stored: string): Promise<boolean> {
    const parsed = parseStoredHash(stored);
    if (!parsed) return false;
    try {
      const key = await deriveKey(
        plain,
        parsed.salt,
        parsed.key.length,
        parsed.params,
      );
      return timingSafeEqual(key, parsed.key);
    } catch {
      return false;
    }
  }

  /**
   * The work of a `verify` against a real hash, for a login whose email is unknown, so that
   * answering "no such user" takes as long as answering "wrong password". The result is dropped.
   */
  async verifyAgainstDummy(plain: string): Promise<void> {
    this.dummyHash ??= this.hash(randomBytes(16).toString('hex'));
    await this.verify(plain, await this.dummyHash);
  }
}
