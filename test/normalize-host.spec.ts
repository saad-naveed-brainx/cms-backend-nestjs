import { normalizeHost } from '../src/sites/normalize-host.js';
import { LONGEST_HOST, MALFORMED_HOSTS } from './support/hosts.js';

/**
 * Tidying a raw Host value (FND-04): letter case, one trailing dot and a port are ignored, and
 * anything else odd is refused with `null`. The check runs before lower-casing, so a letter that
 * only lower-cases to ASCII (the Kelvin sign) is refused rather than silently matched.
 */
describe('normalizeHost', () => {
  it('[UC-HR-05] ignores capital letters, one trailing dot and a port', () => {
    const typed = [
      'corrick.test',
      'Corrick.TEST',
      'corrick.test:3000',
      'corrick.test.',
      'CORRICK.test.:8080',
    ];

    for (const raw of typed) {
      expect(normalizeHost(raw), `normalizeHost(${JSON.stringify(raw)})`).toBe(
        'corrick.test',
      );
    }
  });

  it('[UC-HR-15] returns null for a missing or malformed address, whatever its shape', () => {
    // The use case's list, then what the contract adds: no trimming, one trailing dot at most, a
    // port of digits only, ASCII letters, digits, hyphens and dots only, and strings only.
    const alsoMalformed: { what: string; raw: unknown }[] = [
      { what: 'a leading space (no trimming)', raw: ' corrick.test' },
      { what: 'a trailing space (no trimming)', raw: 'corrick.test ' },
      { what: 'a trailing newline', raw: 'corrick.test\n' },
      { what: 'two trailing dots', raw: 'corrick.test..' },
      { what: 'a leading dot', raw: '.corrick.test' },
      { what: 'a port with no host', raw: ':3000' },
      { what: 'an empty port', raw: 'corrick.test:' },
      { what: 'port 65536', raw: 'corrick.test:65536' },
      { what: 'two ports', raw: 'corrick.test:3000:80' },
      { what: 'an underscore', raw: 'a_b.test' },
      { what: 'a percent escape', raw: 'corrick%2Etest' },
      { what: 'a null', raw: null },
      { what: 'a number', raw: 42 },
      { what: 'an object', raw: { host: 'corrick.test' } },
      { what: 'a one-item array', raw: ['corrick.test'] },
    ];

    for (const { what, raw } of [...MALFORMED_HOSTS, ...alsoMalformed]) {
      expect(normalizeHost(raw), what).toBeNull();
    }
  });

  it('[UC-HR-15] still accepts what sits just inside the limits', () => {
    const longestLabel = `${'a'.repeat(63)}.test`;
    const accepted: [string, string][] = [
      [longestLabel, longestLabel],
      [LONGEST_HOST, LONGEST_HOST], // 253 characters
      [`${LONGEST_HOST}.`, LONGEST_HOST], // 253 once the trailing dot is removed
      [`${LONGEST_HOST}:8080`, LONGEST_HOST], // and once the port is removed
      ['corrick.test:1', 'corrick.test'],
      ['corrick.test:65535', 'corrick.test'],
      ['test', 'test'], // a single label is an address too (UC-HR-06 asks for one)
      ['Shop-2.Corrick.TEST', 'shop-2.corrick.test'],
    ];

    for (const [raw, tidied] of accepted) {
      expect(normalizeHost(raw), `normalizeHost(${raw.slice(0, 30)}...)`).toBe(
        tidied,
      );
    }
  });
});
