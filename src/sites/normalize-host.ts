/** The longest address DNS allows, not counting a trailing dot. */
const MAX_HOST_LENGTH = 253;

/**
 * One part of an address between dots: 1 to 63 ASCII letters, digits or hyphens, with no hyphen at
 * either end. The ranges are spelled out (no `i` flag, no `\w`) so that only plain ASCII matches.
 */
const LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/** A port is 1 to 5 digits worth 1 to 65535. It is checked and then thrown away. */
function isPort(port: string): boolean {
  return (
    /^[0-9]{1,5}$/.test(port) && Number(port) >= 1 && Number(port) <= 65535
  );
}

/**
 * Tidies a raw `Host` value into the form the tables store, or `null` when it is not a web address.
 * Capital letters, one trailing dot and a `:port` are ignored; nothing else is cleaned up.
 *
 * It validates first and lower-cases last, on purpose: JavaScript lower-cases the Kelvin sign
 * (U+212A) to a plain `k`, so lower-casing first would let it through as a real letter. No
 * trimming, no `www.` guessing: a value that is not exactly an address is refused
 * (docs/DECISIONS.md D-017).
 */
export function normalizeHost(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;

  const colon = raw.indexOf(':');
  const hostAndDot = colon === -1 ? raw : raw.slice(0, colon);
  if (colon !== -1 && !isPort(raw.slice(colon + 1))) return null;

  const host = hostAndDot.endsWith('.') ? hostAndDot.slice(0, -1) : hostAndDot;
  if (host.length > MAX_HOST_LENGTH) return null;
  // An empty host, a leading dot and `a..b` all produce an empty label, which LABEL refuses.
  if (!host.split('.').every((label) => LABEL.test(label))) return null;

  return host.toLowerCase();
}
