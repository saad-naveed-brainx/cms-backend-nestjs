type Entry<V> = { value: V | null; expiresAt: number };

/**
 * A small in-memory map from a tidied address to its answer, where `null` means "no site answers
 * here". A site lives `ttlMs`, a "no site" answer the shorter `negativeTtlMs`, and past
 * `maxEntries` the oldest-inserted entry is dropped. The key is the address and nothing else, so
 * one site's answer is never served for another's address (invariant 6).
 *
 * `now` is injectable so tests can move the clock instead of waiting.
 */
export class HostCache<V> {
  private readonly entries = new Map<string, Entry<V>>();
  private readonly now: () => number;

  constructor(
    private readonly options: {
      ttlMs: number;
      negativeTtlMs: number;
      maxEntries: number;
      now?: () => number;
    },
  ) {
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.entries.size;
  }

  /** `{ hit: true, value: null }` is a remembered "no site here"; `{ hit: false }` means ask again. */
  get(key: string): { hit: true; value: V | null } | { hit: false } {
    const entry = this.entries.get(key);
    if (!entry) return { hit: false };
    if (this.now() >= entry.expiresAt) {
      this.entries.delete(key);
      return { hit: false };
    }
    return { hit: true, value: entry.value };
  }

  set(key: string, value: V | null): void {
    const ttl =
      value === null ? this.options.negativeTtlMs : this.options.ttlMs;
    // Delete first, so a key set again counts as newly inserted: a Map keeps the first position.
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + ttl });
    if (this.entries.size > this.options.maxEntries) {
      // A Map iterates in insertion order, so the first key is the oldest.
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  /** Drops every site the predicate matches and returns how many. "No site" entries never match. */
  deleteWhere(predicate: (value: V) => boolean): number {
    let dropped = 0;
    for (const [key, entry] of this.entries) {
      if (entry.value !== null && predicate(entry.value)) {
        this.entries.delete(key);
        dropped += 1;
      }
    }
    return dropped;
  }

  clear(): void {
    this.entries.clear();
  }
}
