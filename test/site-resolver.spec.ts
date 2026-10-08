import { Hostname, Site } from '../src/database/entities/index.js';
import type { HostnameRepository } from '../src/hostnames/hostname.repository.js';
import type { PlatformRepository } from '../src/platform/platform.repository.js';
import { SiteResolver } from '../src/sites/site-resolver.service.js';

/**
 * The resolver's cache behaviour (FND-04), with a fake clock and fakes for the only two things it
 * talks to: the platform desk (address to site) and the hostnames desk (a site's addresses). Each
 * fake counts how often it was asked, so "no lookup" is something a test can see. The fake
 * database hands out a fresh copy of a row on every call, as a real query does, so a change made
 * by a test never leaks into an answer the resolver already holds.
 */

const ORGANIZATION_ID = '0198f2a0-0000-7000-8000-0000000000a9';
const CORRICK_ID = '0198f2a0-0000-7000-8000-00000000c0de';
const BAKERY_ID = '0198f2a0-0000-7000-8000-00000000ba4e';
const OLD_THEME = { palette: 'forest' };
const NEW_THEME = { palette: 'ocean' };
const BAKERY_THEME = { palette: 'honey' };

type StoredAddress = { siteId: string; hostname: string; isPrimary: boolean };

function fakeDatabase() {
  const sites = new Map<string, Site>();
  const addresses: StoredAddress[] = [];

  return {
    addSite(id: string, name: string, theme: Record<string, unknown>) {
      sites.set(
        id,
        Object.assign(new Site(), {
          id,
          organizationId: ORGANIZATION_ID,
          name,
          theme,
          settings: {},
          createdAt: new Date(0),
          updatedAt: new Date(0),
        }),
      );
    },
    addAddress(siteId: string, hostname: string, isPrimary = false) {
      addresses.push({ siteId, hostname, isPrimary });
    },
    setTheme(siteId: string, theme: Record<string, unknown>) {
      sites.set(
        siteId,
        Object.assign(new Site(), sites.get(siteId), { theme }),
      );
    },
    /** Makes `hostname` the site's one primary address. */
    setPrimary(siteId: string, hostname: string) {
      for (const address of addresses) {
        if (address.siteId === siteId) {
          address.isPrimary = address.hostname === hostname;
        }
      }
    },
    /** What the platform desk finds on an address: a fresh copy of the site's row, or null. */
    siteOn(hostname: string): Site | null {
      const address = addresses.find((a) => a.hostname === hostname);
      const site = address && sites.get(address.siteId);
      return site ? structuredClone(site) : null;
    },
    /** What the hostnames desk finds for a site: fresh copies of its address rows. */
    addressesOf(siteId: string): Hostname[] {
      return addresses
        .filter((a) => a.siteId === siteId)
        .map((a) => Object.assign(new Hostname(), a));
    },
  };
}

function fakeClock() {
  let current = 1_700_000_000_000;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

/** A promise a test settles by hand, to hold a lookup open for as long as it needs. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * Corrick (primary `corrick.test`, second `www.corrick.test`) and Bakery (`bakery.test`), a
 * resolver reading them through the two fake desks, and a clock the test moves by hand.
 */
function setup() {
  const db = fakeDatabase();
  db.addSite(CORRICK_ID, 'Corrick', OLD_THEME);
  db.addAddress(CORRICK_ID, 'corrick.test', true);
  db.addAddress(CORRICK_ID, 'www.corrick.test');
  db.addSite(BAKERY_ID, 'Bakery', BAKERY_THEME);
  db.addAddress(BAKERY_ID, 'bakery.test', true);

  const platform = {
    findSiteByHostname: vi.fn(async (hostname: string) => db.siteOn(hostname)),
  };
  const hostnames = {
    findMany: vi.fn(async (siteId: string) => db.addressesOf(siteId)),
  };
  const clock = fakeClock();
  const resolver = new SiteResolver(
    platform as unknown as PlatformRepository,
    hostnames as unknown as HostnameRepository,
    { now: clock.now },
  );
  return { db, platform, hostnames, clock, resolver };
}
type Desks = ReturnType<typeof setup>;

/** Resolves each address in turn and says which of them the platform desk was asked about. */
async function lookedUp(
  { resolver, platform }: Pick<Desks, 'resolver' | 'platform'>,
  hosts: string[],
): Promise<string[]> {
  platform.findSiteByHostname.mockClear();
  for (const host of hosts) {
    await resolver.resolve(host);
  }
  return platform.findSiteByHostname.mock.calls.map(([hostname]) => hostname);
}

describe('SiteResolver cache', () => {
  it('[UC-HR-09] an unknown address is remembered briefly, then asked again', async () => {
    const { resolver, platform, db, clock } = setup();

    expect(await resolver.resolve('new.test')).toBeNull();
    expect(await resolver.resolve('new.test')).toBeNull();
    expect(platform.findSiteByHostname).toHaveBeenCalledTimes(1); // the second call did no lookup

    db.addAddress(CORRICK_ID, 'new.test');
    clock.advance(29_000);
    expect(await resolver.resolve('new.test')).toBeNull(); // still "unknown"...
    expect(platform.findSiteByHostname).toHaveBeenCalledTimes(1); // ...with no lookup

    clock.advance(2_000); // 31 s in total
    const found = await resolver.resolve('new.test');
    expect(platform.findSiteByHostname).toHaveBeenCalledTimes(2);
    expect(found).toMatchObject({
      site: { id: CORRICK_ID, name: 'Corrick' },
      host: 'new.test',
      canonicalHost: 'corrick.test',
      isCanonical: false,
    });
  });

  it('[UC-HR-10] a known address expires after 60 seconds', async () => {
    const { resolver, platform, db, clock } = setup();
    await resolver.resolve('corrick.test');
    expect(platform.findSiteByHostname).toHaveBeenCalledTimes(1);

    db.setTheme(CORRICK_ID, NEW_THEME);

    clock.advance(59_000);
    const at59 = await resolver.resolve('corrick.test');
    expect(at59?.site.theme).toEqual(OLD_THEME);
    expect(platform.findSiteByHostname).toHaveBeenCalledTimes(1);

    clock.advance(2_000); // 61 s since it was first resolved, though read again at 59 s
    const at61 = await resolver.resolve('corrick.test');
    expect(platform.findSiteByHostname).toHaveBeenCalledTimes(2);
    expect(at61?.site.theme).toEqual(NEW_THEME);
  });

  it('[UC-HR-11] invalidateSite drops only the addresses of that site, invalidateHost one address (tidied first), invalidateAll everything', async () => {
    const desks = setup();
    const { resolver, db } = desks;
    const three = ['corrick.test', 'www.corrick.test', 'bakery.test'];

    expect(await lookedUp(desks, three)).toEqual(three); // cold: all three looked up, now cached
    expect(await lookedUp(desks, three)).toEqual([]); // warm: none

    // Corrick's theme and primary address change, then Corrick is invalidated.
    db.setTheme(CORRICK_ID, NEW_THEME);
    db.setPrimary(CORRICK_ID, 'www.corrick.test');
    resolver.invalidateSite(CORRICK_ID);

    expect(await lookedUp(desks, three)).toEqual([
      'corrick.test',
      'www.corrick.test',
    ]); // bakery.test is still served from the cache
    expect(await resolver.resolve('corrick.test')).toMatchObject({
      site: { theme: NEW_THEME },
      canonicalHost: 'www.corrick.test',
      isCanonical: false,
    });
    expect(await resolver.resolve('www.corrick.test')).toMatchObject({
      site: { theme: NEW_THEME },
      canonicalHost: 'www.corrick.test',
      isCanonical: true,
    });

    // invalidateHost tidies its argument like resolve does, and drops that address alone.
    resolver.invalidateHost('Bakery.TEST:8080');
    expect(await lookedUp(desks, three)).toEqual(['bakery.test']);

    resolver.invalidateAll();
    expect(await lookedUp(desks, three)).toEqual(three);
  });

  it('[UC-HR-12] a burst of first requests shares one lookup', async () => {
    const { resolver, platform, hostnames, db } = setup();
    const lookup = deferred<Site | null>();
    platform.findSiteByHostname.mockImplementationOnce(() => lookup.promise);

    // 20 requests arrive while the one lookup is still running; only then does it finish.
    const burst = Array.from({ length: 20 }, () =>
      resolver.resolve('corrick.test'),
    );
    lookup.resolve(db.siteOn('corrick.test'));
    const answers = await Promise.all(burst);

    expect(platform.findSiteByHostname).toHaveBeenCalledTimes(1);
    expect(hostnames.findMany).toHaveBeenCalledTimes(1);
    expect(answers[0]).toMatchObject({
      site: { id: CORRICK_ID, name: 'Corrick' },
      host: 'corrick.test',
      canonicalHost: 'corrick.test',
      isCanonical: true,
    });
    for (const answer of answers) {
      expect(answer).toEqual(answers[0]);
    }
  });

  it('[UC-HR-13] a change during a lookup is not overwritten by the older answer', async () => {
    const { resolver, platform, db } = setup();
    const lookup = deferred<Site | null>();
    const readBeforeTheChange = db.siteOn('corrick.test'); // the old theme
    platform.findSiteByHostname.mockImplementationOnce(() => lookup.promise);

    const first = resolver.resolve('corrick.test');
    const alsoWaiting = resolver.resolve('corrick.test');

    // While that lookup is running, Corrick changes and is invalidated...
    db.setTheme(CORRICK_ID, NEW_THEME);
    resolver.invalidateSite(CORRICK_ID);
    // ...and then the running lookup finishes with the old data.
    lookup.resolve(readBeforeTheChange);

    // The callers waiting on it get its answer.
    expect((await first)?.site.theme).toEqual(OLD_THEME);
    expect((await alsoWaiting)?.site.theme).toEqual(OLD_THEME);

    // But nothing was stored: the next request looks again and sees the new data.
    const next = await resolver.resolve('corrick.test');
    expect(platform.findSiteByHostname).toHaveBeenCalledTimes(2);
    expect(next?.site.theme).toEqual(NEW_THEME);
  });

  it('[UC-HR-13] a request that arrives after the invalidation starts its own lookup, and the old answer finishing last does not overwrite it', async () => {
    const { resolver, platform, db } = setup();
    const lookup = deferred<Site | null>();
    const readBeforeTheChange = db.siteOn('corrick.test'); // the old theme
    platform.findSiteByHostname.mockImplementationOnce(() => lookup.promise);

    const stale = resolver.resolve('corrick.test'); // held open
    db.setTheme(CORRICK_ID, NEW_THEME);
    resolver.invalidateSite(CORRICK_ID);

    // A visitor arriving now must not join the old lookup: it gets the new data at once.
    const fresh = await resolver.resolve('corrick.test');
    expect(fresh?.site.theme).toEqual(NEW_THEME);
    expect(platform.findSiteByHostname).toHaveBeenCalledTimes(2);

    // The old lookup finishes last. Its own caller still gets its answer...
    lookup.resolve(readBeforeTheChange);
    expect((await stale)?.site.theme).toEqual(OLD_THEME);

    // ...but it did not replace the newer one: the next request is served the new data from the
    // cache, with no third lookup.
    const later = await resolver.resolve('corrick.test');
    expect(later?.site.theme).toEqual(NEW_THEME);
    expect(platform.findSiteByHostname).toHaveBeenCalledTimes(2);
  });

  it('[UC-HR-14] remembers the 1000 most recent unknown addresses and has dropped the earliest', async () => {
    const { resolver, platform } = setup();
    const address = (i: number) => `host-${i}.test`;

    for (let i = 0; i < 1200; i++) {
      expect(await resolver.resolve(address(i))).toBeNull();
    }
    expect(platform.findSiteByHostname).toHaveBeenCalledTimes(1200);

    // The 1000 most recent are still remembered: asking again looks nothing up.
    for (let i = 200; i < 1200; i++) {
      await resolver.resolve(address(i));
    }
    expect(platform.findSiteByHostname).toHaveBeenCalledTimes(1200);

    // The earliest was dropped: asking for it again is a lookup again.
    expect(await resolver.resolve(address(0))).toBeNull();
    expect(platform.findSiteByHostname).toHaveBeenCalledTimes(1201);
    expect(platform.findSiteByHostname).toHaveBeenLastCalledWith(address(0));
  });

  it('[UC-HR-16] a database failure rejects with that error and is not remembered as "unknown"', async () => {
    const failures: {
      desk: string;
      fail: (desks: Desks, error: Error) => void;
    }[] = [
      {
        desk: 'the platform desk',
        fail: ({ platform }, error) =>
          void platform.findSiteByHostname.mockRejectedValueOnce(error),
      },
      {
        desk: 'the hostnames desk',
        fail: ({ hostnames }, error) =>
          void hostnames.findMany.mockRejectedValueOnce(error),
      },
    ];

    for (const { desk, fail } of failures) {
      const desks = setup();
      const failure = new Error(`connection lost (${desk})`);
      fail(desks, failure);

      await expect(desks.resolver.resolve('corrick.test'), desk).rejects.toBe(
        failure,
      );

      // Nothing wrong was cached: the next call looks again and finds Corrick.
      expect(await desks.resolver.resolve('corrick.test'), desk).toMatchObject({
        site: { id: CORRICK_ID, name: 'Corrick' },
        host: 'corrick.test',
        canonicalHost: 'corrick.test',
        isCanonical: true,
      });
    }
  });
});
