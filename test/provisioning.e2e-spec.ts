import type { INestApplication } from '@nestjs/common';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { PasswordService } from '../src/auth/password.service.js';
import { Permission } from '../src/auth/permission.js';
import { ContentTypeRepository } from '../src/content-types/content-type.repository.js';
import {
  ContentType,
  Hostname,
  Organization,
  Role,
  Site,
  SiteMember,
  User,
} from '../src/database/entities/index.js';
import { HostnameRepository } from '../src/hostnames/hostname.repository.js';
import { SiteMemberRepository } from '../src/members/site-member.repository.js';
import { PlatformRepository } from '../src/platform/platform.repository.js';
import { ProvisioningRepository } from '../src/provisioning/provisioning.repository.js';
import { ProvisioningService } from '../src/provisioning/provisioning.service.js';
import {
  HostnameTakenError,
  ProvisionInputError,
} from '../src/provisioning/tenant-input.js';
import { SiteResolver } from '../src/sites/site-resolver.service.js';
import { createTestApp } from './support/app.js';
import { resetDatabase } from './support/database.js';
import { ProbeController } from './support/probe.controller.js';
import {
  everythingStored,
  noRows,
  rowCounts,
  tenantInput,
} from './support/tenant.js';

/**
 * Creating a tenant (FND-06): `ProvisioningService.provisionTenant` against real Postgres, with the
 * real password hasher. A tenant is built here from the service alone (no fixture of one anywhere),
 * and then read back three ways: straight from the tables, through the scoped desks, and through
 * the real routes (`POST /auth/login`, a permission-protected route, `GET /sites/resolve`).
 *
 * Every name, address, email and password below is this file's own; none is something the app
 * could have defaulted to. "Nothing was created" is a row count of every table.
 */

// Production-cost scrypt takes about 0.2 s a hash, and a test here hashes and verifies a few times.
vi.setConfig({ testTimeout: 30_000 });

const ADMIN_EMAIL = 'olivia@orchard.test';
const ALL_PERMISSIONS = Object.values(Permission);

const sorted = <T>(values: readonly T[]): T[] => [...values].sort();

type Membership = {
  site: { id: string; name: string };
  role: { id: string; name: string };
  permissions: Permission[];
};

describe('creating a tenant', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let provisioning: ProvisioningService;
  const passwords = new PasswordService();

  beforeAll(async () => {
    ({ app, dataSource } = await createTestApp([ProbeController]));
    // Listening on a loopback port keeps supertest from opening and closing a listener of its own around
    // each request: with several requests in a row that race sometimes ends in "socket hang up".
    await app.listen(0, '127.0.0.1');
    provisioning = app.get(ProvisioningService);
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
    // The resolver remembers answers for a minute: start every test from a cold cache.
    app.get(SiteResolver).invalidateAll();
  });

  afterAll(async () => {
    await app.close();
  });

  const provision = (input: unknown) => provisioning.provisionTenant(input);
  const server = () => request(app.getHttpServer());
  const login = (email: string, password: string) =>
    server().post('/auth/login').send({ email, password });
  const resolveHost = (host: string) =>
    server().get('/sites/resolve').query({ host });

  /** What a promise was rejected with, or `undefined` when it was not rejected. */
  const rejection = (promise: Promise<unknown>): Promise<unknown> =>
    promise.then(
      () => undefined,
      (error: unknown) => error,
    );

  it('[UC-TS-01] creates the organisation, site, address, role, membership, two content types and the admin, and nothing else', async () => {
    const password = 'orchard-opening-pass';

    const result = await provision(
      tenantInput({ admin: { email: 'Olivia@Orchard.TEST', password } }),
    );

    // The database holds exactly what one tenant is made of: no stray row in any table.
    expect(await rowCounts(dataSource)).toEqual({
      ...noRows(dataSource),
      users: 1,
      organizations: 1,
      sites: 1,
      hostnames: 1,
      roles: 1,
      site_members: 1,
      content_types: 2,
    });

    // The admin: the email is lower-cased, and only a scrypt hash of the password is kept.
    const [user] = await dataSource.getRepository(User).find();
    expect(user.email).toBe(ADMIN_EMAIL);
    expect(user.name).toBe('Olivia Orchard');
    expect(user.passwordHash).toMatch(/^scrypt\$/);
    expect(user.passwordHash).not.toContain(password);
    expect(await passwords.verify(password, user.passwordHash)).toBe(true);

    // One organisation owned by the admin, one site in it with a theme and settings of nothing.
    const [org] = await dataSource.getRepository(Organization).find();
    expect(org).toMatchObject({ name: 'Orchard Holdings', ownerId: user.id });
    const [site] = await dataSource.getRepository(Site).find();
    expect(site).toMatchObject({
      name: 'Orchard Bakery',
      organizationId: org.id,
    });
    expect(site.theme).toEqual({});
    expect(site.settings).toEqual({});

    // One address, the primary one; one Administrator role holding every permission there is; the
    // admin's membership with that role.
    const [address] = await dataSource.getRepository(Hostname).find();
    expect(address).toMatchObject({
      siteId: site.id,
      hostname: 'orchard.test',
      isPrimary: true,
    });
    const [role] = await dataSource.getRepository(Role).find();
    expect(role).toMatchObject({ siteId: site.id, name: 'Administrator' });
    expect(sorted(role.permissions)).toEqual(sorted(ALL_PERMISSIONS));
    const [member] = await dataSource.getRepository(SiteMember).find();
    expect(member).toMatchObject({
      siteId: site.id,
      userId: user.id,
      roleId: role.id,
    });

    // The two built-in content types, both of this site.
    const types = await dataSource.getRepository(ContentType).find();
    const bySlug = Object.fromEntries(types.map((type) => [type.slug, type]));
    expect(Object.keys(bySlug).sort()).toEqual(['page', 'post']);
    expect(types.map((type) => type.siteId)).toEqual([site.id, site.id]);
    expect(bySlug.page).toMatchObject({
      name: 'Page',
      urlPrefix: null,
      hierarchical: true,
      isBuiltin: true,
      hasCategories: false,
      hasTags: false,
    });
    expect(bySlug.post).toMatchObject({
      name: 'Post',
      urlPrefix: '/blog',
      hierarchical: false,
      isBuiltin: true,
      hasCategories: true,
      hasTags: true,
    });
    expect(bySlug.page.fields).toEqual([]);
    expect(bySlug.post.fields).toEqual([]);

    // The result names the three ids, and nothing else the caller has to guess.
    expect(result).toEqual({
      organization: { id: org.id, name: 'Orchard Holdings' },
      site: { id: site.id, name: 'Orchard Bakery' },
      hostnames: ['orchard.test'],
      admin: { id: user.id, email: ADMIN_EMAIL, created: true },
    });
  });

  it('[UC-TS-02] the seeded admin signs in, passes a members.manage route on the site, and the address resolves, all through the real routes', async () => {
    const password = 'orchard-real-flow-pass';
    const result = await provision(tenantInput({ admin: { password } }));
    const [role] = await dataSource
      .getRepository(Role)
      .findBy({ siteId: result.site.id });

    const signedIn = await login(ADMIN_EMAIL, password);

    expect(signedIn.status).toBe(200);
    expect(signedIn.body.memberships).toHaveLength(1);
    const [membership] = signedIn.body.memberships as Membership[];
    expect(membership.site).toEqual({
      id: result.site.id,
      name: 'Orchard Bakery',
    });
    expect(membership.role).toEqual({ id: role.id, name: 'Administrator' });
    expect(sorted(membership.permissions)).toEqual(sorted(ALL_PERMISSIONS));

    // members.manage on that site, with the token the login gave and the site named in the header.
    const bearer = `Bearer ${signedIn.body.accessToken}`;
    const allowed = await server()
      .get('/probe/members')
      .set('Authorization', bearer)
      .set('X-Site-Id', result.site.id);
    expect(allowed.status).toBe(200);
    // Control: the same route is closed without a token, so the 200 above is the role's doing.
    const closed = await server()
      .get('/probe/members')
      .set('X-Site-Id', result.site.id);
    expect(closed.status).toBe(401);

    // The public website finds the site by its address, with no login at all.
    const resolved = await resolveHost('orchard.test');
    expect(resolved.status).toBe(200);
    expect(resolved.body).toEqual({
      site: {
        id: result.site.id,
        name: 'Orchard Bakery',
        theme: {},
        settings: {},
      },
      host: 'orchard.test',
      canonicalHost: 'orchard.test',
      isCanonical: true,
    });
  });

  it('[UC-TS-03] several addresses are tidied and de-duplicated, the first is primary, and the second resolves to it', async () => {
    const result = await provision(
      tenantInput({
        hostnames: ['A.test', 'www.a.test', 'a.test:3000'],
        admin: { password: 'orchard-addresses-pass' },
      }),
    );

    // `A.test` and `a.test:3000` are the same address once tidied: two addresses remain, in order.
    expect(result.hostnames).toEqual(['a.test', 'www.a.test']);
    const rows = await dataSource
      .getRepository(Hostname)
      .findBy({ siteId: result.site.id });
    expect(rows).toHaveLength(2);
    expect(
      Object.fromEntries(rows.map((row) => [row.hostname, row.isPrimary])),
    ).toEqual({ 'a.test': true, 'www.a.test': false });

    const www = await resolveHost('www.a.test');
    expect(www.status).toBe(200);
    expect(www.body.site.id).toBe(result.site.id);
    expect(www.body).toMatchObject({
      host: 'www.a.test',
      canonicalHost: 'a.test',
      isCanonical: false,
    });

    // Any spelling of the first one finds the same site, and it is its own canonical address.
    const primary = await resolveHost('A.test:3000');
    expect(primary.status).toBe(200);
    expect(primary.body.site.id).toBe(result.site.id);
    expect(primary.body).toMatchObject({
      host: 'a.test',
      canonicalHost: 'a.test',
      isCanonical: true,
    });
  });

  it('[UC-TS-04] with no password given, a 24-character one is generated and shown once, only its hash is stored, and it signs in', async () => {
    const first = await provision(tenantInput());
    const generated = first.admin.generatedPassword;

    expect(first.admin.created).toBe(true);
    expect(generated).toMatch(/^[A-Za-z0-9_-]{24}$/);

    // Only the hash is stored: the password appears in no column of any table.
    const [user] = await dataSource.getRepository(User).find();
    expect(user.passwordHash).toMatch(/^scrypt\$/);
    expect(await everythingStored(dataSource)).not.toContain(generated);

    const signedIn = await login(ADMIN_EMAIL, generated as string);
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.user.id).toBe(first.admin.id);

    // Random, not a constant: another new admin is given another password.
    const second = await provision(
      tenantInput({
        organizationName: 'Other Holdings',
        siteName: 'Other Shop',
        hostnames: ['other.test'],
        admin: { email: 'ravi@other.test', name: 'Ravi Other' },
      }),
    );
    expect(second.admin.generatedPassword).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(second.admin.generatedPassword).not.toBe(generated);
  });

  it('[UC-TS-05] a supplied password is used exactly as given, and never echoed or kept', async () => {
    // Twelve characters, the shortest allowed, with a space at each end: a trim would leave ten, and
    // refuse it. Spaces are part of a password.
    const password = ' correct-pw ';
    expect(password).toHaveLength(12);

    const result = await provision(tenantInput({ admin: { password } }));

    // The result holds no password field and no hash, whatever it is called.
    expect(Object.keys(result.admin).sort()).toEqual([
      'created',
      'email',
      'id',
    ]);
    const [user] = await dataSource.getRepository(User).find();
    const shown = JSON.stringify(result);
    expect(shown).not.toMatch(/password|scrypt/i);
    expect(shown).not.toContain(password.trim());
    expect(shown).not.toContain(user.passwordHash);
    expect(await everythingStored(dataSource)).not.toContain(password.trim());

    // Exactly that password signs in, and the same one without its spaces does not.
    expect((await login(ADMIN_EMAIL, password)).status).toBe(200);
    expect((await login(ADMIN_EMAIL, password.trim())).status).toBe(401);
  });

  it('[UC-TS-06] an existing user can run a second tenant, with the old password kept, and a password for them is refused', async () => {
    const password = 'xena-first-password';
    const first = await provision(
      tenantInput({
        organizationName: 'North Agency',
        siteName: 'North Shop',
        hostnames: ['north.test'],
        admin: { email: 'xena@agency.test', name: 'Xena Agent', password },
      }),
    );
    const users = dataSource.getRepository(User);
    const before = await users.findOneByOrFail({ email: 'xena@agency.test' });

    // The same email, spelled with capitals, and no password.
    const second = await provision(
      tenantInput({
        organizationName: 'South Agency',
        siteName: 'South Shop',
        hostnames: ['south.test', 'www.south.test'],
        admin: { email: 'XENA@Agency.TEST', name: 'Xena Agent' },
      }),
    );

    // The same person, found and not created again, and no password handed out for them.
    expect(second.admin.id).toBe(first.admin.id);
    expect(second.admin.created).toBe(false);
    expect(Object.keys(second.admin).sort()).toEqual([
      'created',
      'email',
      'id',
    ]);
    expect(await rowCounts(dataSource)).toEqual({
      ...noRows(dataSource),
      users: 1,
      organizations: 2,
      sites: 2,
      hostnames: 3,
      roles: 2,
      site_members: 2,
      content_types: 4,
    });
    const after = await users.findOneByOrFail({ email: 'xena@agency.test' });
    expect(after.passwordHash).toBe(before.passwordHash);

    // The second tenant has rows of its own, not the first one's.
    expect(second.site.id).not.toBe(first.site.id);
    expect(second.organization.id).not.toBe(first.organization.id);
    const [secondOrg] = await dataSource
      .getRepository(Organization)
      .findBy({ id: second.organization.id });
    expect(secondOrg).toMatchObject({
      name: 'South Agency',
      ownerId: first.admin.id,
    });
    const secondRoles = await dataSource
      .getRepository(Role)
      .findBy({ siteId: second.site.id });
    expect(secondRoles.map((role) => role.name)).toEqual(['Administrator']);
    const firstRoles = await dataSource
      .getRepository(Role)
      .findBy({ siteId: first.site.id });
    expect(secondRoles[0].id).not.toBe(firstRoles[0].id);
    const secondTypes = await dataSource
      .getRepository(ContentType)
      .findBy({ siteId: second.site.id });
    expect(sorted(secondTypes.map((type) => type.slug))).toEqual([
      'page',
      'post',
    ]);
    const secondAddresses = await dataSource
      .getRepository(Hostname)
      .findBy({ siteId: second.site.id });
    expect(
      Object.fromEntries(
        secondAddresses.map((row) => [row.hostname, row.isPrimary]),
      ),
    ).toEqual({ 'south.test': true, 'www.south.test': false });

    // The original password still works, and the login lists both sites, each as Administrator.
    const signedIn = await login('xena@agency.test', password);
    expect(signedIn.status).toBe(200);
    const memberships = signedIn.body.memberships as Membership[];
    expect(
      memberships.map((m) => [m.site.id, m.site.name, m.role.name]),
    ).toEqual([
      [first.site.id, 'North Shop', 'Administrator'],
      [second.site.id, 'South Shop', 'Administrator'],
    ]);
    for (const membership of memberships) {
      expect(sorted(membership.permissions), membership.site.name).toEqual(
        sorted(ALL_PERMISSIONS),
      );
    }

    // A password for someone who already has one is refused with a clear message, and nothing is
    // created: not the organisation, the site or the address of the refused attempt.
    const counts = await rowCounts(dataSource);
    const refusal = await rejection(
      provision(
        tenantInput({
          organizationName: 'East Agency',
          siteName: 'East Shop',
          hostnames: ['east.test'],
          admin: {
            email: 'xena@agency.test',
            name: 'Xena Agent',
            password: 'xena-another-password',
          },
        }),
      ),
    );
    expect(refusal).toBeInstanceOf(ProvisionInputError);
    expect((refusal as ProvisionInputError).message).toMatch(/already exists/i);
    expect((refusal as ProvisionInputError).message).toMatch(
      /omit the password/i,
    );
    expect(await rowCounts(dataSource)).toEqual(counts);
    expect(
      (await users.findOneByOrFail({ email: 'xena@agency.test' })).passwordHash,
    ).toBe(before.passwordHash);
  });

  it('[UC-TS-07] bad input is refused with an error that names the problem, and nothing is created', async () => {
    const good = tenantInput();
    const omit = (value: object, key: string) =>
      Object.fromEntries(
        Object.entries(value).filter(([name]) => name !== key),
      );
    const withAdmin = (fields: object) => ({
      ...good,
      admin: { ...good.admin, ...fields },
    });
    const elevenAddresses = Array.from(
      { length: 11 },
      (_, index) => `site${index + 1}.test`,
    );

    // `names` is what the message must mention; `offending` the address it must quote.
    const cases: {
      what: string;
      input: unknown;
      names?: RegExp;
      offending?: string;
    }[] = [
      {
        what: 'no organisation',
        input: omit(good, 'organizationName'),
        names: /organi[sz]ation/i,
      },
      { what: 'no site', input: omit(good, 'siteName'), names: /site/i },
      {
        what: 'an empty site name',
        input: { ...good, siteName: '' },
        names: /site/i,
      },
      {
        what: 'a site name of only spaces',
        input: { ...good, siteName: '   ' },
        names: /site/i,
      },
      {
        what: 'a site name of 121 characters',
        input: { ...good, siteName: 'x'.repeat(121) },
        names: /site/i,
      },
      {
        what: 'no address (an empty list)',
        input: { ...good, hostnames: [] },
        names: /host|address/i,
      },
      {
        what: 'no address (no list at all)',
        input: omit(good, 'hostnames'),
        names: /host|address/i,
      },
      {
        what: '11 addresses',
        input: { ...good, hostnames: elevenAddresses },
        names: /host|address/i,
      },
      {
        what: 'an address with a space in it, after a good one',
        input: { ...good, hostnames: ['fine.test', 'a b.test'] },
        offending: 'a b.test',
      },
      {
        what: 'an address with a slash in it',
        input: { ...good, hostnames: ['a/b'] },
        offending: 'a/b',
      },
      {
        what: 'the addresses given as a text, not a list',
        input: { ...good, hostnames: 'orchard.test' },
        names: /host|address/i,
      },
      { what: 'no admin', input: omit(good, 'admin'), names: /admin/i },
      {
        what: 'no email',
        input: { ...good, admin: omit(good.admin, 'email') },
        names: /email/i,
      },
      {
        what: 'an email with no @',
        input: withAdmin({ email: 'not-an-email' }),
        names: /email/i,
      },
      {
        what: 'an email with nothing after the @',
        input: withAdmin({ email: 'olivia@' }),
        names: /email/i,
      },
      {
        what: 'no admin name',
        input: { ...good, admin: omit(good.admin, 'name') },
        names: /name/i,
      },
      {
        what: 'an empty admin name',
        input: withAdmin({ name: '' }),
        names: /name/i,
      },
      {
        what: 'a password of 11 characters',
        input: withAdmin({ password: 'x'.repeat(11) }),
        names: /password/i,
      },
      { what: 'no input at all', input: undefined },
      { what: 'null', input: null },
      { what: 'a text', input: 'orchard' },
      { what: 'a number', input: 42 },
      { what: 'a list', input: [] },
    ];

    for (const { what, input, names, offending } of cases) {
      const error = await rejection(provision(input));

      expect(error, what).toBeInstanceOf(ProvisionInputError);
      const refusal = error as ProvisionInputError;
      expect(refusal.problems.length, `${what}: problems`).toBeGreaterThan(0);
      expect(refusal.message, `${what}: message`).toMatch(/\S/);
      if (names) {
        expect(refusal.message, `${what}: names the problem`).toMatch(names);
      }
      if (offending) {
        expect(refusal.message, `${what}: names the address`).toContain(
          offending,
        );
      }
      expect(
        await rowCounts(dataSource),
        `${what}: nothing is created`,
      ).toEqual(noRows(dataSource));
    }
  });

  it('[UC-TS-08] a taken address stops everything: the error names it, and not one row of the failed attempt remains', async () => {
    await provision(
      tenantInput({
        hostnames: ['taken.test'],
        admin: { password: 'first-tenant-password' },
      }),
    );
    const before = await rowCounts(dataSource);

    // A new user, organisation and site, and two addresses: `new.test` is written before the
    // conflict on `taken.test` (spelled with capitals), so the rollback has something to undo.
    const failure = await rejection(
      provision(
        tenantInput({
          organizationName: 'Second Holdings',
          siteName: 'Second Shop',
          hostnames: ['new.test', 'Taken.TEST'],
          admin: { email: 'sam@second.test', name: 'Sam Second' },
        }),
      ),
    );

    expect(failure).toBeInstanceOf(HostnameTakenError);
    expect((failure as HostnameTakenError).hostname).toBe('taken.test');
    expect((failure as HostnameTakenError).message).toContain('taken.test');

    expect(await rowCounts(dataSource)).toEqual(before);
    expect(
      await dataSource.getRepository(User).findBy({ email: 'sam@second.test' }),
    ).toEqual([]);
    expect(
      await dataSource.getRepository(Hostname).findBy({ hostname: 'new.test' }),
    ).toEqual([]);
  });

  it('[UC-TS-09] two tenants stay apart: each site, read through the scoped desks, sees only its own rows', async () => {
    const alpha = await provision(
      tenantInput({
        organizationName: 'Alpha Holdings',
        siteName: 'Alpha Site',
        hostnames: ['alpha.test', 'www.alpha.test'],
        admin: {
          email: 'ann@alpha.test',
          name: 'Ann Alpha',
          password: 'alpha-admin-password',
        },
      }),
    );
    const beta = await provision(
      tenantInput({
        organizationName: 'Beta Holdings',
        siteName: 'Beta Site',
        hostnames: ['beta.test'],
        admin: {
          email: 'ben@beta.test',
          name: 'Ben Beta',
          password: 'beta-admin-password',
        },
      }),
    );
    const addresses = app.get(HostnameRepository);
    const members = app.get(SiteMemberRepository);
    const types = app.get(ContentTypeRepository);
    const ownedIds: string[] = [];

    for (const [mine, theirs] of [
      [alpha, beta],
      [beta, alpha],
    ] as const) {
      const site = mine.site.name;

      // Its own addresses, and one primary: the first.
      const hosts = await addresses.findMany(mine.site.id);
      expect(sorted(hosts.map((row) => row.hostname)), site).toEqual(
        sorted(mine.hostnames),
      );
      expect(
        hosts.filter((row) => row.isPrimary).map((row) => row.hostname),
        site,
      ).toEqual([mine.hostnames[0]]);

      // Its own membership: its admin, and not the other tenant's.
      const memberRows = await members.findMany(mine.site.id);
      expect(
        memberRows.map((row) => row.userId),
        site,
      ).toEqual([mine.admin.id]);
      expect(
        await members.findAccess(mine.site.id, theirs.admin.id),
        site,
      ).toBe(null);

      // Its own role: the one Administrator row on the site is the one the membership holds.
      const access = await members.findAccess(mine.site.id, mine.admin.id);
      expect(access, site).toMatchObject({ roleName: 'Administrator' });
      expect(sorted(access?.permissions ?? []), site).toEqual(
        sorted(ALL_PERMISSIONS),
      );
      const roles = await dataSource
        .getRepository(Role)
        .findBy({ siteId: mine.site.id });
      expect(
        roles.map((role) => [role.id, role.name]),
        site,
      ).toEqual([[access?.roleId, 'Administrator']]);

      // Its own two content types.
      const owned = await types.findMany(mine.site.id);
      expect(sorted(owned.map((type) => type.slug)), site).toEqual([
        'page',
        'post',
      ]);
      expect(
        owned.every((type) => type.siteId === mine.site.id),
        site,
      ).toBe(true);

      ownedIds.push(...roles.map((role) => role.id));
      ownedIds.push(...owned.map((type) => type.id));
    }

    // Nothing is shared: two roles and four content types, every id its own.
    expect(ownedIds).toHaveLength(6);
    expect(new Set(ownedIds).size).toBe(6);
  });

  it('[UC-TS-13] the platform desk keeps its five methods, only the provisioning desk touches TypeORM among the new files, the schema is unchanged and the seed script exists', async () => {
    const methodsOf = (type: { prototype: object }) =>
      Object.getOwnPropertyNames(type.prototype)
        .filter((name) => name !== 'constructor')
        .sort();
    expect(methodsOf(PlatformRepository)).toEqual([
      'findMembershipsByUserId',
      'findOrganizationsOwnedBy',
      'findSiteByHostname',
      'findUserByEmail',
      'findUserById',
    ]);
    // The second unscoped desk is as narrow as the first: its two creations, named for what they do.
    expect(
      methodsOf(ProvisioningRepository),
      'ProvisioningRepository is the only place that creates a tenant or a site, so it has createTenant and createSite and nothing else (helpers belong outside the class)',
    ).toEqual(['createSite', 'createTenant']);

    // The lint rule lets only `*.repository.ts` import TypeORM: of the new files, only this one does.
    const srcDir = fileURLToPath(new URL('../src/', import.meta.url));
    const newFiles = ['provisioning', 'cli'].flatMap((folder) =>
      existsSync(`${srcDir}${folder}`)
        ? readdirSync(`${srcDir}${folder}`)
            .filter((file) => file.endsWith('.ts'))
            .map((file) => `${folder}/${file}`)
        : [],
    );
    expect(newFiles).toEqual(
      expect.arrayContaining([
        'provisioning/tenant-input.ts',
        'provisioning/provisioning.repository.ts',
        'provisioning/provisioning.service.ts',
        'provisioning/provisioning.module.ts',
        'cli/seed-args.ts',
        'cli/run-seed.ts',
        'cli/seed.ts',
      ]),
    );
    const importsTypeOrm = (file: string) =>
      /(?:from|import)\s*\(?\s*['"](?:typeorm|@nestjs\/typeorm)(?:\/[^'"]*)?['"]/.test(
        readFileSync(`${srcDir}${file}`, 'utf8'),
      );
    expect(newFiles.filter(importsTypeOrm)).toEqual([
      'provisioning/provisioning.repository.ts',
    ]);

    // No migration is pending: the entities and the migrated database still agree.
    const pending = await dataSource.driver.createSchemaBuilder().log();
    expect(pending.upQueries.map((query) => query.query)).toEqual([]);

    // The command is wired into `npm run`: it builds, then runs the compiled entrypoint.
    const packageJson = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../package.json', import.meta.url)),
        'utf8',
      ),
    ) as { scripts: Record<string, string | undefined> };
    expect(packageJson.scripts.seed).toMatch(/build/);
    expect(packageJson.scripts.seed).toMatch(/node\s+dist\/cli\/seed\.js/);
  });
});
