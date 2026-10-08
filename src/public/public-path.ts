import { BadRequestException } from '@nestjs/common';

/** The page a visitor to `/` is shown: the site's page at this address. */
export const HOME_PATH = '/home';

const SEGMENT = '[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*';
const PATH = new RegExp(`^/(?:${SEGMENT}(?:/${SEGMENT})*/?)?$`);
const MAX_PATH_LENGTH = 300;

/**
 * The address on the site a visitor asked for: `/`, `/about`, `/blog/hello`. Words of letters,
 * digits and hyphens between single slashes, and one trailing slash means the same address.
 * Capitals are kept as they are: a page's address is lower-case, so `/About` is just an address
 * nobody has used (a 404), not a second way to reach `/about`. Anything else is a 400, decided
 * before any database call.
 */
export function parsePublicPath(raw: unknown): string {
  if (
    typeof raw !== 'string' ||
    raw.length > MAX_PATH_LENGTH ||
    !PATH.test(raw)
  ) {
    throw new BadRequestException(
      'path must be an address on the site, like /about',
    );
  }
  return raw.length > 1 && raw.endsWith('/') ? raw.slice(0, -1) : raw;
}
