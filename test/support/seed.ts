import type { DataSource } from 'typeorm';
import { Permission } from '../../src/auth/permission.js';
import {
  Content,
  ContentType,
  Hostname,
  Organization,
  Role,
  Site,
  SiteMember,
  User,
} from '../../src/database/entities/index.js';

export type TwoSites = {
  user: User;
  corrick: { site: Site; editor: Role };
  bakery: { site: Site; editor: Role };
};

/**
 * Two tenants under one agency, each with its own Editor role, plus one user. The smallest data
 * set that can show one tenant's rows staying out of the other's.
 */
export async function seedTwoSites(dataSource: DataSource): Promise<TwoSites> {
  const m = dataSource.manager;
  const user = await m.save(
    m.create(User, {
      email: 'ayesha@corrick.test',
      passwordHash: 'x',
      name: 'Ayesha',
    }),
  );
  const org = await m.save(
    m.create(Organization, { name: 'Agency', ownerId: user.id }),
  );

  const site = (name: string) =>
    m.save(m.create(Site, { organizationId: org.id, name }));
  const editor = (siteId: string) =>
    m.save(
      m.create(Role, {
        siteId,
        name: 'Editor',
        permissions: [Permission.ContentPublish],
      }),
    );

  const corrickSite = await site('Corrick');
  const bakerySite = await site('Bakery');
  return {
    user,
    corrick: { site: corrickSite, editor: await editor(corrickSite.id) },
    bakery: { site: bakerySite, editor: await editor(bakerySite.id) },
  };
}

/** What a test must say about a page it seeds. Everything else takes the table's defaults. */
export type PageSeed = Pick<
  Content,
  'siteId' | 'contentTypeId' | 'title' | 'slug' | 'path'
> &
  Partial<Content>;

/**
 * A page type written straight to the table, past the desks, so a test of a desk's reads does not
 * depend on that desk's own writes. Defaults to a hierarchical "Page" type.
 */
export async function seedContentType(
  dataSource: DataSource,
  fields: Pick<ContentType, 'siteId'> & Partial<ContentType>,
): Promise<ContentType> {
  const m = dataSource.manager;
  return m.save(
    m.create(ContentType, {
      name: 'Page',
      slug: 'page',
      hierarchical: true,
      ...fields,
    }),
  );
}

/** A page written straight to the table, past the desks. */
export async function seedPage(
  dataSource: DataSource,
  fields: PageSeed,
): Promise<Content> {
  const m = dataSource.manager;
  return m.save(m.create(Content, fields));
}

/** A page that is in the trash (`deletedAt` set), written straight to the table. */
export async function seedTrashedPage(
  dataSource: DataSource,
  fields: PageSeed,
): Promise<Content> {
  return seedPage(dataSource, { deletedAt: new Date(), ...fields });
}

/**
 * A web address a site answers on, written straight to the table, past the platform desk. The
 * table refuses anything but lower-case, and a site can have only one primary address.
 */
export async function seedHostname(
  dataSource: DataSource,
  siteId: string,
  hostname: string,
  isPrimary = false,
): Promise<Hostname> {
  const m = dataSource.manager;
  return m.save(m.create(Hostname, { siteId, hostname, isPrimary }));
}

/** Everyone in the auth tests signs in with this one password. */
export const TEST_PASSWORD = 'correct horse battery staple';

/** Cheap scrypt settings: seeding a user takes a millisecond or two instead of production's ~100 ms. */
const CHEAP_SCRYPT = { N: 1024, r: 8, p: 1 };

/**
 * A user who can really sign in: `password` is hashed with the real `PasswordService` (cheap
 * settings), so a login test proves that what the hasher writes is what the login step reads.
 * `email` is stored exactly as given: the table refuses anything but lower case.
 */
export async function seedUser(
  dataSource: DataSource,
  fields: { email: string; name: string; password: string },
): Promise<User> {
  // Loaded when first needed, so a suite that only seeds sites does not load the auth code.
  const { PasswordService } =
    await import('../../src/auth/password.service.js');
  const passwordHash = await new PasswordService().hash(
    fields.password,
    CHEAP_SCRYPT,
  );
  const m = dataSource.manager;
  return m.save(
    m.create(User, { email: fields.email, name: fields.name, passwordHash }),
  );
}

/** A role on a site with exactly these permissions, written straight to the table. */
export async function seedRole(
  dataSource: DataSource,
  fields: { siteId: string; name: string; permissions: Permission[] },
): Promise<Role> {
  const m = dataSource.manager;
  return m.save(m.create(Role, fields));
}

/** Makes `userId` a member of `siteId` with the role `roleId` (a role of that same site). */
export async function seedMembership(
  dataSource: DataSource,
  fields: { siteId: string; userId: string; roleId: string },
): Promise<SiteMember> {
  const m = dataSource.manager;
  return m.save(m.create(SiteMember, fields));
}

export type AuthWorld = {
  corrick: { site: Site; editor: Role; admin: Role; viewer: Role };
  bakery: { site: Site; contributor: Role };
  ayesha: User;
  bilal: User;
  chen: User;
  dana: User;
};

/**
 * The people and sites of the auth use cases, all signing in with `TEST_PASSWORD`:
 *
 * - Ayesha is an Editor on Corrick (`content.create`, `content.publish`) and nowhere else.
 * - Bilal is a Viewer on Corrick: a member whose role grants nothing.
 * - Chen belongs to no site.
 * - Dana is an Admin on Corrick (the two content permissions plus `members.manage` and
 *   `settings.manage`) and a Contributor on Bakery (`content.create`).
 *
 * An agency owner owns the organisation, so deleting any of the four people is allowed. Each
 * role's permissions are listed in a fixed order (alphabetical, which is also the order the
 * `Permission` enum declares them in), so tests can compare them as written.
 */
export async function seedAuthWorld(
  dataSource: DataSource,
): Promise<AuthWorld> {
  const m = dataSource.manager;
  const person = (email: string, name: string) =>
    seedUser(dataSource, { email, name, password: TEST_PASSWORD });

  const owner = await person('owner@agency.test', 'Agency Owner');
  const org = await m.save(
    m.create(Organization, { name: 'Agency', ownerId: owner.id }),
  );
  const corrickSite = await m.save(
    m.create(Site, { organizationId: org.id, name: 'Corrick' }),
  );
  const bakerySite = await m.save(
    m.create(Site, { organizationId: org.id, name: 'Bakery' }),
  );
  // Corrick has a main address and a second one; Bakery has none, so sign-in answers null for it.
  await seedHostname(dataSource, corrickSite.id, 'corrick.test', true);
  await seedHostname(dataSource, corrickSite.id, 'www.corrick.test');

  const corrickRoles = {
    editor: await seedRole(dataSource, {
      siteId: corrickSite.id,
      name: 'Editor',
      permissions: [Permission.ContentCreate, Permission.ContentPublish],
    }),
    admin: await seedRole(dataSource, {
      siteId: corrickSite.id,
      name: 'Admin',
      permissions: [
        Permission.ContentCreate,
        Permission.ContentPublish,
        Permission.MembersManage,
        Permission.SettingsManage,
      ],
    }),
    viewer: await seedRole(dataSource, {
      siteId: corrickSite.id,
      name: 'Viewer',
      permissions: [],
    }),
  };
  const contributor = await seedRole(dataSource, {
    siteId: bakerySite.id,
    name: 'Contributor',
    permissions: [Permission.ContentCreate],
  });

  const ayesha = await person('ayesha@corrick.test', 'Ayesha');
  const bilal = await person('bilal@corrick.test', 'Bilal');
  const chen = await person('chen@nowhere.test', 'Chen');
  const dana = await person('dana@agency.test', 'Dana');

  const member = (siteId: string, userId: string, roleId: string) =>
    seedMembership(dataSource, { siteId, userId, roleId });
  await member(corrickSite.id, ayesha.id, corrickRoles.editor.id);
  await member(corrickSite.id, bilal.id, corrickRoles.viewer.id);
  await member(corrickSite.id, dana.id, corrickRoles.admin.id);
  await member(bakerySite.id, dana.id, contributor.id);

  return {
    corrick: { site: corrickSite, ...corrickRoles },
    bakery: { site: bakerySite, contributor },
    ayesha,
    bilal,
    chen,
    dana,
  };
}
