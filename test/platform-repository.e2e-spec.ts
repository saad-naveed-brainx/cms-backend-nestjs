import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { Site, User } from '../src/database/entities/index.js';
import { PlatformRepository } from '../src/platform/platform.repository.js';
import { createTestApp } from './support/app.js';
import { resetDatabase } from './support/database.js';
import { seedHostname, seedTwoSites, type TwoSites } from './support/seed.js';

/**
 * The platform desk (FND-02): the one desk that reads across sites. It answers the two questions
 * asked before any site is known: which site answers on this web address, and which user has this
 * email.
 *
 * Both seeded sites have web addresses and there are two users in every test, so a lookup that
 * ignored what it was asked, or mixed its rows up, would visibly return the wrong site or user.
 * Addresses and emails are seeded straight into the tables (test/support/seed.ts), past the desk.
 */
describe('platform desk: cross-site lookups', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let platform: PlatformRepository;
  let data: TwoSites;
  let corrick: Site;
  let bakery: Site;
  let ayesha: User;
  let bilal: User;

  beforeAll(async () => {
    ({ app, dataSource } = await createTestApp());
    platform = app.get(PlatformRepository);
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
    data = await seedTwoSites(dataSource);
    corrick = data.corrick.site;
    bakery = data.bakery.site;
    ayesha = data.user;

    // Corrick answers on two addresses (the first is its primary one), Bakery on one.
    await seedHostname(dataSource, corrick.id, 'corrick.test', true);
    await seedHostname(dataSource, corrick.id, 'www.corrick.test');
    await seedHostname(dataSource, bakery.id, 'bakery.test', true);

    // A second user, so a lookup that returned "the first user" or "the last user" shows.
    const m = dataSource.manager;
    bilal = await m.save(
      m.create(User, {
        email: 'bilal@bakery.test',
        passwordHash: 'bilals-hash',
        name: 'Bilal',
      }),
    );
  });

  afterAll(async () => {
    await app.close();
  });

  /**
   * The id each typed value finds (`null` for nothing), keyed by what was typed, so a wrong
   * answer names the input that caused it.
   */
  const idsFound = async (
    typed: string[],
    lookup: (value: string) => Promise<{ id: string } | null>,
  ): Promise<Record<string, string | null>> =>
    Object.fromEntries(
      await Promise.all(
        typed.map(async (value): Promise<[string, string | null]> => [
          value,
          (await lookup(value))?.id ?? null,
        ]),
      ),
    );
  const siteIdsFor = (typed: string[]) =>
    idsFound(typed, (address) => platform.findSiteByHostname(address));
  const userIdsFor = (typed: string[]) =>
    idsFound(typed, (email) => platform.findUserByEmail(email));

  /** What a lookup must answer for every one of these: nothing. */
  const nothingFor = (typed: string[]) =>
    Object.fromEntries(typed.map((value) => [value, null]));

  describe('web address to site', () => {
    it("[UC-SR-07] resolves each of Corrick's addresses, the primary and the www one, to the Corrick site", async () => {
      const primary = await platform.findSiteByHostname('corrick.test');
      const www = await platform.findSiteByHostname('www.corrick.test');

      expect(primary).toMatchObject({ id: corrick.id, name: 'Corrick' });
      expect(www).toMatchObject({ id: corrick.id, name: 'Corrick' });
    });

    it("[UC-SR-07] resolves Bakery's address to the Bakery site, never to Corrick", async () => {
      const found = await platform.findSiteByHostname('bakery.test');

      expect(found).toMatchObject({ id: bakery.id, name: 'Bakery' });
    });

    it('[UC-SR-07] keeps the two sites apart: every address answers with its own site and no other', async () => {
      const addresses = ['corrick.test', 'www.corrick.test', 'bakery.test'];

      const found = await Promise.all(
        addresses.map((address) => platform.findSiteByHostname(address)),
      );

      expect(found.map((site: Site | null) => site?.id)).toEqual([
        corrick.id,
        corrick.id,
        bakery.id,
      ]);
      expect(found.map((site: Site | null) => site?.name)).toEqual([
        'Corrick',
        'Corrick',
        'Bakery',
      ]);
    });

    it('[UC-SR-07] keeps no state between calls: asking again, in turn or all at once, gives the same site', async () => {
      const asked = [
        'corrick.test',
        'bakery.test',
        'corrick.test',
        'www.corrick.test',
        'bakery.test',
        'corrick.test',
      ];
      const expected = [
        corrick.id,
        bakery.id,
        corrick.id,
        corrick.id,
        bakery.id,
        corrick.id,
      ];

      const inTurn: (string | undefined)[] = [];
      for (const address of asked) {
        inTurn.push((await platform.findSiteByHostname(address))?.id);
      }
      const allAtOnce = await Promise.all(
        asked.map((address) => platform.findSiteByHostname(address)),
      );

      expect(inTurn).toEqual(expected);
      expect(allAtOnce.map((site: Site | null) => site?.id)).toEqual(expected);
    });

    it('[UC-SR-07] returns the whole site as stored, with its theme and settings, not only its id', async () => {
      await dataSource.manager.update(
        Site,
        { id: corrick.id },
        { theme: { palette: 'forest' }, settings: { footer: 'Since 1990' } },
      );
      const stored = await dataSource.manager.findOneByOrFail(Site, {
        id: corrick.id,
      });

      const found = await platform.findSiteByHostname('corrick.test');

      expect(found).toEqual(stored);
      expect(found?.theme).toEqual({ palette: 'forest' });
      expect(found?.settings).toEqual({ footer: 'Since 1990' });
    });

    it('[UC-SR-12] finds the same site whatever the letter case of the web address', async () => {
      const lowerCase = await platform.findSiteByHostname('corrick.test');
      expect(lowerCase).toMatchObject({ id: corrick.id, name: 'Corrick' });

      // The use case's own example, and the very same site as the lower-case address finds.
      expect(await platform.findSiteByHostname('Corrick.TEST')).toEqual(
        lowerCase,
      );

      // Other capitalisations, for either site and for the www address.
      const typed = {
        'CORRICK.TEST': corrick.id,
        'corrick.TEST': corrick.id,
        'WWW.Corrick.Test': corrick.id,
        'Bakery.TEST': bakery.id,
      };
      expect(await siteIdsFor(Object.keys(typed))).toEqual(typed);
    });

    it('[UC-SR-12] only lower-cases the web address: a space or a port makes it another address, which finds nothing', async () => {
      // Trimming and port stripping are FND-04's job (assumption 5): the desk does not guess.
      const typed = [
        'corrick.test ',
        ' corrick.test',
        'corrick.test:3000',
        'www.corrick.test:3000',
        'bakery.test ',
      ];

      expect(await siteIdsFor(typed)).toEqual(nothingFor(typed));
    });

    it('[UC-SR-13] returns null, not an error, for a web address no site answers on', async () => {
      await expect(
        platform.findSiteByHostname('nobody.test'),
      ).resolves.toBeNull();
    });

    it('[UC-SR-13] matches a web address whole: a piece of a real one, a site name or a search pattern finds nothing', async () => {
      const typed = [
        'www.bakery.test', // Bakery never registered a www address
        'orrick.test',
        'corrick.tes',
        'corrick', // the site's name, not an address
        'test',
        '%', // a search wildcard is an ordinary character here
        '%.test',
        'corrick_test', // `_` would stand for the dot in a pattern match
        "corrick.test' OR '1'='1",
      ];

      expect(await siteIdsFor(typed)).toEqual(nothingFor(typed));
    });
  });

  describe('email to user', () => {
    it('[UC-SR-08] finds the user by email, with the stored password hash the login step needs', async () => {
      const storedHash =
        '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$aGFzaGVkLXBhc3N3b3Jk';
      await dataSource.manager.update(
        User,
        { id: ayesha.id },
        { passwordHash: storedHash },
      );

      const found = await platform.findUserByEmail('ayesha@corrick.test');

      expect(found).toMatchObject({
        id: ayesha.id,
        email: 'ayesha@corrick.test',
        name: 'Ayesha',
        passwordHash: storedHash,
      });
    });

    it('[UC-SR-08] finds each user by their own email, not just the first or the last one', async () => {
      const found = await platform.findUserByEmail('bilal@bakery.test');

      expect(found).toMatchObject({
        id: bilal.id,
        email: 'bilal@bakery.test',
        name: 'Bilal',
        passwordHash: 'bilals-hash',
      });
    });

    it('[UC-SR-12] finds the same user whatever the letter case of the email', async () => {
      const lowerCase = await platform.findUserByEmail('ayesha@corrick.test');
      expect(lowerCase).toMatchObject({ id: ayesha.id, name: 'Ayesha' });

      // The use case's own example, and the very same user, hash and all, as the lower-case email finds.
      expect(await platform.findUserByEmail('Ayesha@Corrick.Test')).toEqual(
        lowerCase,
      );

      // Other capitalisations, for either user.
      const typed = {
        'AYESHA@CORRICK.TEST': ayesha.id,
        'ayesha@CORRICK.test': ayesha.id,
        'BILAL@bakery.TEST': bilal.id,
      };
      expect(await userIdsFor(Object.keys(typed))).toEqual(typed);
    });

    it('[UC-SR-12] only lower-cases the email: a space makes it another email, which finds nothing', async () => {
      // Trimming is a later ticket's job (assumption 5): the desk does not guess.
      const typed = [
        'ayesha@corrick.test ',
        ' ayesha@corrick.test',
        'bilal@bakery.test ',
      ];

      expect(await userIdsFor(typed)).toEqual(nothingFor(typed));
    });

    it('[UC-SR-13] returns null, not an error, for an email no user has', async () => {
      await expect(
        platform.findUserByEmail('ghost@nowhere.test'),
      ).resolves.toBeNull();
    });

    it('[UC-SR-13] matches an email whole: a piece of a real one or a search pattern finds nothing', async () => {
      const typed = [
        'ayesha',
        'ayesha@corrick',
        'yesha@corrick.test',
        'corrick.test',
        '%', // a search wildcard is an ordinary character here
        '%@corrick.test',
        'ayesha_corrick.test', // `_` would stand for the @ in a pattern match
        "ayesha@corrick.test' OR '1'='1",
      ];

      expect(await userIdsFor(typed)).toEqual(nothingFor(typed));
    });
  });
});
