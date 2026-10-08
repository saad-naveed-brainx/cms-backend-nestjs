/** The value shipped in `.env.example`: fine on a laptop, refused in production. */
const DEV_DEFAULT_SECRET = 'dev-only-change-me';

/** A signing secret under this many characters is too easy to guess in production. */
const MIN_PRODUCTION_SECRET_LENGTH = 32;

const DEFAULT_EXPIRES_IN = '7d';

/**
 * The login token's signing secret and lifetime, read from the environment, so a missing or weak
 * secret stops the app at start-up instead of signing tokens anyone could forge. The error never
 * repeats the secret.
 */
export function readAuthConfig(env: Record<string, string | undefined>): {
  secret: string;
  expiresIn: string;
} {
  const secret = env.JWT_SECRET;
  if (!secret) {
    throw new Error(
      'JWT_SECRET is required: set it in the environment (api/.env.example shows the name)',
    );
  }

  if (env.NODE_ENV === 'production') {
    if (secret === DEV_DEFAULT_SECRET) {
      throw new Error(
        'JWT_SECRET is still the development default: set a real secret in production',
      );
    }
    if (secret.length < MIN_PRODUCTION_SECRET_LENGTH) {
      throw new Error(
        `JWT_SECRET must be at least ${MIN_PRODUCTION_SECRET_LENGTH} characters in production (it is ${secret.length})`,
      );
    }
  }

  return { secret, expiresIn: env.JWT_EXPIRES_IN || DEFAULT_EXPIRES_IN };
}
