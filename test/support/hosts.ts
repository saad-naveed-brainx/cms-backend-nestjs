/**
 * Web addresses shaped to sit on either side of the address rules (FND-04, UC-HR-15), shared by the
 * unit test of `normalizeHost` and the API test of `GET /sites/resolve`.
 */

const label = (length: number) => 'a'.repeat(length);

/** Exactly 253 characters, in labels of at most 63: the longest name the rules allow. */
export const LONGEST_HOST = [label(63), label(63), label(63), label(61)].join(
  '.',
);

/** 254 characters: one more than the longest name allowed. */
export const TOO_LONG_HOST = [label(63), label(63), label(63), label(62)].join(
  '.',
);

/**
 * Every kind of malformed `host` from UC-HR-15, as a client could send it. `raw` is what the
 * resolver is given: `undefined` for no `host` at all, an array for `host` sent twice (that is what
 * the query parser makes of it), a string otherwise. `what` names the case in a failure message.
 */
export const MALFORMED_HOSTS: { what: string; raw: unknown }[] = [
  { what: 'no host at all', raw: undefined },
  { what: 'an empty value', raw: '' },
  { what: 'spaces only', raw: '   ' },
  { what: 'a space inside the name', raw: 'a b.test' },
  { what: 'a NUL character', raw: 'corrick\u0000.test' },
  { what: 'a path', raw: 'corrick.test/path' },
  { what: 'a user name', raw: 'user@corrick.test' },
  { what: 'a query string', raw: 'corrick.test?x=1' },
  { what: 'an empty label', raw: 'a..b.test' },
  { what: 'a label starting with a hyphen', raw: '-a.test' },
  { what: 'a label ending with a hyphen', raw: 'a-.test' },
  { what: 'a label of 64 characters', raw: `${label(64)}.test` },
  { what: 'a name over 253 characters', raw: TOO_LONG_HOST },
  { what: 'port 0', raw: 'corrick.test:0' },
  { what: 'port 70000', raw: 'corrick.test:70000' },
  { what: 'a port that is not a number', raw: 'corrick.test:abc' },
  { what: 'a bracketed IPv6 address', raw: '[::1]' },
  { what: 'a bare IPv6 address', raw: '::1' },
  // U+212A lower-cases to the plain letter k, so "corrick.test" would be found by accident.
  { what: 'the Kelvin-sign letter', raw: 'corricK.test' },
  { what: 'a non-ASCII letter', raw: 'café.test' },
  { what: 'host given twice', raw: ['a.test', 'b.test'] },
];
