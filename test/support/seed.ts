import type { DataSource } from 'typeorm';
import { Permission } from '../../src/auth/permission.js';
import {
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
