import { BadRequestException } from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { ContentStatus } from '../database/entities/content.entity.js';

/** A page's title: tidied (trimmed), then 1 to 200 characters. */
const title = z.string().trim().min(1).max(200);

/**
 * A page's slug: lower-case letters and digits in words joined by single hyphens, up to 80
 * characters. The caller sends it; the server does not make one up (CNT-04 adds proper slug
 * handling).
 */
const slug = z
  .string()
  .min(1)
  .max(80)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    'use lower-case letters, digits and single hyphens',
  );

const typeSlug = z.string().min(1).max(60);

/**
 * The layout. Each block is an object with a `type`; the rest of its shape is the contract in
 * `cms-blocks` (invariant 7) and is stored as sent. Not sanitised yet: that is BLK-05, so nothing
 * may render a block's text as HTML before then.
 */
const block = z.looseObject({ type: z.string().min(1).max(60) });
const blocks = z.array(block).max(200);

/** Custom field values; checked against the content type's fields in TYP-02. */
const data = z.record(z.string(), z.unknown());

/** Text a person may leave out: tidied (trimmed), and empty means none (`null`). */
const clearableText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((value) => value || null);

/**
 * The search-engine fields (SEO-01). The title and description replace the page's own in search
 * results; `canonicalUrl` is another address search engines should treat as this page's original
 * (a full `https://` or `http://` address, nothing the browser could run); `noIndex` keeps the page
 * out of search results. The share image waits for the media library (`ogImageId`, MED).
 */
const seo = {
  seoTitle: clearableText(200).optional(),
  seoDescription: clearableText(500).optional(),
  canonicalUrl: clearableText(2000)
    .pipe(
      z
        .url({
          protocol: /^https?$/,
          error: 'use a full address starting with https:// or http://',
        })
        .nullable(),
    )
    .optional(),
  noIndex: z.boolean().optional(),
};

/** Strict: a field that is not listed (a `siteId`, a `path`, a `status`) is an error, never ignored. */
export const createPageBody = z.strictObject({
  type: typeSlug,
  title,
  slug,
  blocks: blocks.optional(),
  data: data.optional(),
  ...seo,
});

/** The address, status and parent do not change here: CNT-04, CNT-03 and CNT-05/06. */
export const updatePageBody = z
  .strictObject({
    title: title.optional(),
    blocks: blocks.optional(),
    data: data.optional(),
    ...seo,
  })
  .refine((body) => Object.keys(body).length > 0, {
    message:
      'give at least one of title, blocks, data, seoTitle, seoDescription, canonicalUrl, noIndex',
  });

export const listQuery = z.object({
  type: typeSlug.optional(),
  status: z.enum(ContentStatus).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

export type CreatePageBody = z.infer<typeof createPageBody>;
export type UpdatePageBody = z.infer<typeof updatePageBody>;
export type ListQuery = z.infer<typeof listQuery>;

/** The checked value, or a 400 whose `errors` list the problems, one `field: message` line each. */
export function parseOr400<T extends z.ZodType>(
  schema: T,
  value: unknown,
): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new BadRequestException({
    message: 'Invalid request',
    errors: parsed.error.issues.map(
      (issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`,
    ),
  });
}

const isRichText = (value: unknown): boolean =>
  typeof value === 'object' &&
  value !== null &&
  (value as { type?: unknown }).type === 'richText';

/**
 * A `richText` block holds HTML, and HTML is only safe to store once it is cleaned when it is
 * saved (BLK-05, docs/DECISIONS.md D-021). Until then none is accepted: a 400 listing each
 * offender as `blocks.N: ...`. A page that already holds one (from before this rule) may keep it
 * exactly as it is, so it can still be edited; `stored` is that page's blocks. Changing it, or
 * adding another, is refused.
 */
export function refuseUncleanedBlocks(
  blocks: readonly unknown[],
  stored: readonly unknown[] = [],
): void {
  const kept = stored.filter(isRichText);
  const problems = blocks.flatMap((block, index) =>
    isRichText(block) && !kept.some((old) => isDeepStrictEqual(old, block))
      ? [
          `blocks.${index}: a richText block is not accepted yet: its HTML is only safe once it is cleaned on save (BLK-05)`,
        ]
      : [],
  );
  if (problems.length > 0) {
    throw new BadRequestException({
      message: 'Invalid request',
      errors: problems,
    });
  }
}
