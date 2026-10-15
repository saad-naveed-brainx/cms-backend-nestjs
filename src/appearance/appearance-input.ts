import { z } from 'zod';

/**
 * A colour the website may draw with: hex, or rgb / hsl / oklch / oklab with plain numbers. Nothing
 * that could carry more than a colour into the site's CSS. The same rule as the website's own
 * (web/src/site/resolve-theme.ts), which also checks what it reads.
 */
const COLOUR =
  /^(?:#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|(?:rgba?|hsla?|oklch|oklab)\([0-9a-z .,%/+-]{1,60}\))$/i;
const colour = z
  .string()
  .regex(COLOUR, 'use a colour (#1f4fd8, rgb(…), oklch(…))');

/**
 * A whole theme, as the website draws it (web/src/theme/theme.ts): one of each named choice and the
 * eight colours. Mirrors the website's lists by hand; a choice added there must be added here.
 */
const theme = z.strictObject({
  typeSet: z.enum(['editorial', 'technical']),
  shape: z.enum(['soft', 'sharp']),
  density: z.enum(['comfortable', 'tight']),
  texture: z.enum(['none', 'grain', 'grid']),
  palette: z.strictObject({
    paper: colour,
    surface: colour,
    ink: colour,
    muted: colour,
    line: colour,
    brand: colour,
    onBrand: colour,
    accent: colour,
  }),
});

/** Tidied (trimmed); empty clears it. */
const line = (max: number) => z.string().trim().max(max);

/**
 * The logo's address (MED-03, D-042): a picture from the media library, so a full `https://` or
 * `http://` address (the API's own, `MEDIA_PUBLIC_URL`). Nothing the browser could run. Empty clears it.
 */
const logoUrl = z
  .string()
  .trim()
  .max(2000)
  .refine((value) => value === '' || /^https?:\/\/[^\s]+$/i.test(value), {
    message: 'use a full picture address starting with https:// or http://',
  });

/**
 * A change to the site's appearance (GOV-04). Strict: anything not listed (a `siteId`) is an error.
 * The name is the site's own (what the header shows and titles end with); the theme is sent whole.
 */
export const appearanceBody = z
  .strictObject({
    name: z.string().trim().min(1).max(120).optional(),
    tagline: line(120).optional(),
    footerNote: line(300).optional(),
    logoUrl: logoUrl.optional(),
    theme: theme.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'give at least one of name, tagline, footerNote, logoUrl, theme',
  });

export type AppearanceBody = z.infer<typeof appearanceBody>;
