import { BadRequestException } from '@nestjs/common';
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

/** Strict: a field that is not listed (a `siteId`, a `path`, a `status`) is an error, never ignored. */
export const createPageBody = z.strictObject({
  type: typeSlug,
  title,
  slug,
  blocks: blocks.optional(),
  data: data.optional(),
});

/** The address, status and parent do not change here: CNT-04, CNT-03 and CNT-05/06. */
export const updatePageBody = z
  .strictObject({
    title: title.optional(),
    blocks: blocks.optional(),
    data: data.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'give at least one of title, blocks, data',
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
