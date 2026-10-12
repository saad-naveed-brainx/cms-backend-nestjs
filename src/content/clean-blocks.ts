import { BadRequestException } from '@nestjs/common';
import sanitizeHtml from 'sanitize-html';

/**
 * What a text block may hold (BLK-05, D-041): paragraphs, line breaks, bold, italic, underline,
 * strike-through, two heading sizes, lists, quotes and links. Everything else is taken out when the
 * page is saved, keeping its words; a script or style goes with its contents. The website draws
 * what is stored as it is (invariant 5: cleaned on save, never on read).
 */
const RULES: sanitizeHtml.IOptions = {
  allowedTags: [
    'p',
    'br',
    'strong',
    'em',
    'u',
    's',
    'h2',
    'h3',
    'ul',
    'ol',
    'li',
    'blockquote',
    'a',
  ],
  allowedAttributes: { a: ['href'] },
  // A web address, an email, a phone number, or an address on this site. Never `javascript:`.
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesAppliedToAttributes: ['href'],
  allowProtocolRelative: false,
  transformTags: { b: 'strong', i: 'em', strike: 's', h1: 'h2', h4: 'h3' },
};

/** The HTML of a text block as it may be stored. */
export const cleanHtml = (html: string): string =>
  sanitizeHtml(html, RULES).trim();

/** Up to this many characters of HTML in one text block, before cleaning. */
const MAX_HTML = 50_000;
const MAX_HEADING = 200;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The blocks as they are stored: each `richText` block becomes `{ type, heading?, html }` with its
 * HTML cleaned; every other block is kept as sent. A text block without `html` text, or with too
 * much, is a 400 listing each one as `blocks.N: ...`.
 */
export function cleanBlocks<T>(blocks: readonly T[]): T[] {
  const problems: string[] = [];
  const cleaned = blocks.map((block, index) => {
    if (!isRecord(block) || block.type !== 'richText') return block;
    const { html, heading } = block;
    if (typeof html !== 'string') {
      problems.push(`blocks.${index}: a richText block needs its text as html`);
      return block;
    }
    if (html.length > MAX_HTML) {
      problems.push(
        `blocks.${index}: a richText block holds at most ${MAX_HTML} characters`,
      );
      return block;
    }
    if (
      heading !== undefined &&
      (typeof heading !== 'string' || heading.length > MAX_HEADING)
    ) {
      problems.push(
        `blocks.${index}: a richText heading is text of at most ${MAX_HEADING} characters`,
      );
      return block;
    }
    const tidyHeading = heading?.trim();
    return {
      type: 'richText',
      ...(tidyHeading ? { heading: tidyHeading } : {}),
      html: cleanHtml(html),
    } as T;
  });
  if (problems.length > 0) {
    throw new BadRequestException({
      message: 'Invalid request',
      errors: problems,
    });
  }
  return cleaned;
}
