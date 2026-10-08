import { HostCache } from '../src/sites/host-cache.js';

/**
 * The small in-memory map behind host resolution (FND-04): two expiry times, a size limit that
 * drops the oldest first, and removal by key, by value or all at once. Time comes from a fake
 * clock, so nothing here waits.
 */
const TTL_MS = 60_000;
const NEGATIVE_TTL_MS = 30_000;

type Answer = { id: string };

function cacheWithClock(maxEntries = 1000) {
  let current = 1_000_000;
  const cache = new HostCache<Answer>({
    ttlMs: TTL_MS,
    negativeTtlMs: NEGATIVE_TTL_MS,
    maxEntries,
    now: () => current,
  });
  return {
    cache,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe('HostCache', () => {
  it('[UC-HR-10] serves a stored value until its ttlMs has passed, then it is a miss', () => {
    const { cache, advance } = cacheWithClock();
    const corrick = { id: 'corrick' };

    expect(cache.get('corrick.test')).toEqual({ hit: false });
    cache.set('corrick.test', corrick);
    expect(cache.get('corrick.test')).toEqual({ hit: true, value: corrick });

    advance(TTL_MS - 1);
    expect(cache.get('corrick.test')).toEqual({ hit: true, value: corrick });

    advance(2); // TTL_MS + 1 since it was stored, however often it was read since
    expect(cache.get('corrick.test')).toEqual({ hit: false });
  });

  it('[UC-HR-09] remembers "no site answers here" (null) for negativeTtlMs, shorter than ttlMs', () => {
    const { cache, advance } = cacheWithClock();

    cache.set('new.test', null);
    // A remembered "unknown" is a hit that carries null: not a miss, and not an absent value.
    expect(cache.get('new.test')).toEqual({ hit: true, value: null });

    advance(NEGATIVE_TTL_MS - 1);
    expect(cache.get('new.test')).toEqual({ hit: true, value: null });

    advance(2);
    expect(cache.get('new.test')).toEqual({ hit: false });
  });

  it('[UC-HR-11] delete drops one key, deleteWhere drops the values it matches (never a null) and counts them, clear drops all', () => {
    const { cache } = cacheWithClock();
    cache.set('corrick.test', { id: 'corrick' });
    cache.set('www.corrick.test', { id: 'corrick' });
    cache.set('bakery.test', { id: 'bakery' });
    cache.set('new.test', null);
    expect(cache.size).toBe(4);

    cache.delete('bakery.test');
    expect(cache.get('bakery.test')).toEqual({ hit: false });
    expect(cache.size).toBe(3);

    const asked: unknown[] = [];
    const dropped = cache.deleteWhere((value) => {
      asked.push(value);
      return value.id === 'corrick';
    });
    expect(dropped).toBe(2);
    expect(cache.get('corrick.test')).toEqual({ hit: false });
    expect(cache.get('www.corrick.test')).toEqual({ hit: false });

    // The remembered "unknown" is not a value to match: even "yes to everything" leaves it alone.
    expect(cache.deleteWhere(() => true)).toBe(0);
    expect(asked).not.toContain(null);
    expect(cache.get('new.test')).toEqual({ hit: true, value: null });

    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get('new.test')).toEqual({ hit: false });
  });

  it('[UC-HR-19] deleteNegatives drops every remembered "no site here" and counts them, and leaves known values alone', () => {
    const { cache } = cacheWithClock();
    cache.set('corrick.test', { id: 'corrick' });
    cache.set('bakery.test', { id: 'bakery' });
    cache.set('new.test', null);
    cache.set('other.test', null);

    expect(cache.deleteNegatives()).toBe(2);

    expect(cache.get('new.test')).toEqual({ hit: false });
    expect(cache.get('other.test')).toEqual({ hit: false });
    expect(cache.get('corrick.test')).toEqual({
      hit: true,
      value: { id: 'corrick' },
    });
    expect(cache.get('bakery.test')).toEqual({
      hit: true,
      value: { id: 'bakery' },
    });
    expect(cache.size).toBe(2);
    expect(cache.deleteNegatives()).toBe(0); // nothing left to drop
  });

  it('[UC-HR-14] never holds more than maxEntries, and drops the oldest first', () => {
    const { cache } = cacheWithClock(1000);
    const address = (i: number) => `host-${i}.test`;

    let mostHeld = 0;
    for (let i = 0; i < 1200; i++) {
      cache.set(address(i), null);
      mostHeld = Math.max(mostHeld, cache.size);
    }

    expect(mostHeld).toBe(1000);
    expect(cache.size).toBe(1000);
    const remembered = Array.from({ length: 1200 }, (_, i) =>
      address(i),
    ).filter((key) => cache.get(key).hit);
    // The 1000 most recent are all there, and nothing older is: first and last of an unbroken run.
    expect(remembered).toHaveLength(1000);
    expect(remembered[0]).toBe(address(200));
    expect(remembered.at(-1)).toBe(address(1199));
  });
});
