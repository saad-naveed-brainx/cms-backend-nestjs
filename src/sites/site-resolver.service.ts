import { Injectable, Optional } from '@nestjs/common';
import { HostnameRepository } from '../hostnames/hostname.repository.js';
import { PlatformRepository } from '../platform/platform.repository.js';
import { HostCache } from './host-cache.js';
import { normalizeHost } from './normalize-host.js';

/** The address is not shaped like a web address. Raised before any database call. */
export class InvalidHostError extends Error {}

/** What the public website is told about an address: the site, and where its canonical address is. */
export type ResolvedHost = {
  site: {
    id: string;
    name: string;
    theme: Record<string, unknown>;
    settings: Record<string, unknown>;
  };
  host: string;
  canonicalHost: string;
  isCanonical: boolean;
};

/**
 * Answers "which site is this address?" for every page view, so it remembers the answer in memory
 * (docs/DECISIONS.md D-017): a site for 60 s, "no site" for 30 s, at most 1000 addresses.
 * Whoever changes a site's addresses, name, theme or settings must call `invalidateSite`.
 */
@Injectable()
export class SiteResolver {
  private readonly cache: HostCache<ResolvedHost>;

  /** The lookups running right now, one per address, so a burst of callers shares one query. */
  private readonly running = new Map<string, Promise<ResolvedHost | null>>();

  /**
   * Bumped by every invalidate*. A lookup notes the number it started under; if it has moved on by
   * the time the answer arrives, the answer may predate the change. It is handed to the callers
   * already waiting but not stored, or an old answer would overwrite the fresh one.
   */
  private generation = 0;

  constructor(
    private readonly platform: PlatformRepository,
    private readonly hostnames: HostnameRepository,
    @Optional() options?: { now?: () => number },
  ) {
    this.cache = new HostCache({
      ttlMs: 60_000,
      negativeTtlMs: 30_000,
      maxEntries: 1000,
      now: options?.now,
    });
  }

  /**
   * The site that answers on this address, or `null` when none does. Throws `InvalidHostError` for
   * a malformed address, and rethrows a database error without caching anything.
   */
  async resolve(rawHost: unknown): Promise<ResolvedHost | null> {
    const host = normalizeHost(rawHost);
    if (host === null) {
      throw new InvalidHostError('host must be a valid web address');
    }

    const cached = this.cache.get(host);
    if (cached.hit) return cached.value;

    const sharing = this.running.get(host);
    if (sharing) return sharing;

    const generation = this.generation;
    const lookup: Promise<ResolvedHost | null> = this.lookUp(host)
      .then((resolved) => {
        // A failed lookup skips this step, so an error is never stored: a database hiccup must
        // not turn into "no site answers here" for the next 30 seconds.
        if (generation === this.generation) this.cache.set(host, resolved);
        return resolved;
      })
      .finally(() => {
        // An invalidation may already have replaced this entry with a newer lookup. Leave that one.
        if (this.running.get(host) === lookup) this.running.delete(host);
      });
    this.running.set(host, lookup);
    return lookup;
  }

  /** Forgets one address, tidied first. An address that is not valid cannot be cached: ignored. */
  invalidateHost(host: string): void {
    const key = normalizeHost(host);
    if (key === null) return;
    this.cache.delete(key);
    this.forgetRunning();
  }

  /**
   * Forgets every address of one site. Call it once the change is saved: a lookup that starts
   * before then reads the old row.
   */
  invalidateSite(siteId: string): void {
    this.cache.deleteWhere((resolved) => resolved.site.id === siteId);
    this.forgetRunning();
  }

  invalidateAll(): void {
    this.cache.clear();
    this.forgetRunning();
  }

  /**
   * Every invalidation ends here. It bumps the generation, so a running lookup's answer is not
   * stored, and forgets the running lookups, so callers arriving later start a fresh one instead of
   * joining a stale one. All of them, because a lookup's site is not known until it finishes.
   */
  private forgetRunning(): void {
    this.generation += 1;
    this.running.clear();
  }

  /** Two reads, no cache: the site by address, then that site's addresses for its primary one. */
  private async lookUp(host: string): Promise<ResolvedHost | null> {
    const site = await this.platform.findSiteByHostname(host);
    if (!site) return null;

    const addresses = await this.hostnames.findMany(site.id);
    const canonicalHost =
      addresses.find((address) => address.isPrimary)?.hostname ?? host;

    return {
      site: {
        id: site.id,
        name: site.name,
        theme: site.theme,
        settings: site.settings,
      },
      host,
      canonicalHost,
      isCanonical: canonicalHost === host,
    };
  }
}
