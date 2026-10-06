import type { DataSource } from 'typeorm';
import { Permission } from '../../src/auth/permission.js';
import {
  Content,
  ContentType,
  Organization,
  Role,
  Site,
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
