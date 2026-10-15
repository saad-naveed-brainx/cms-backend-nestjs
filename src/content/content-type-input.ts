import { z } from 'zod';

/**
 * A new content type (TYP-01 minimum, D-043): its name, singular as the admin shows it ("Recipe"),
 * and the address its items live under ("/recipes": one word or hyphenated words, lower case).
 * Strict: anything else (fields, a slug, a `siteId`) is an error.
 */
export const createTypeBody = z.strictObject({
  name: z.string().trim().min(1).max(60),
  urlPrefix: z
    .string()
    .trim()
    .max(60)
    .regex(
      /^\/[a-z0-9]+(?:-[a-z0-9]+)*$/,
      'use one address on the site in lower-case letters, digits and hyphens, like /recipes',
    ),
});

export type CreateTypeBody = z.infer<typeof createTypeBody>;

/** Addresses the website keeps for itself: its own routes, and the front page (D-037). */
export const RESERVED_PREFIXES = ['/api', '/home'];

/** The type's internal key from its name: "Team Member" is `team-member`; `''` when nothing is left. */
export function slugFromName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
}
