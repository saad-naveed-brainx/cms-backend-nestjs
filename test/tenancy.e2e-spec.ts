import type { INestApplication } from '@nestjs/common';
import { QueryFailedError, type DataSource } from 'typeorm';
import { SiteMember } from '../src/database/entities/index.js';
import { createTestApp } from './support/app.js';
import { resetDatabase } from './support/database.js';
import { seedTwoSites, type TwoSites } from './support/seed.js';

describe('tenant isolation in the database', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let data: TwoSites;

  beforeAll(async () => {
    ({ app, dataSource } = await createTestApp());
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
    data = await seedTwoSites(dataSource);
  });

  afterAll(async () => {
    await app.close();
  });

  it('[UC-SR-52] lets a user hold a role that belongs to the same site', async () => {
    const m = dataSource.manager;
    await m.save(
      m.create(SiteMember, {
        siteId: data.corrick.site.id,
        userId: data.user.id,
        roleId: data.corrick.editor.id,
      }),
    );

    expect(await m.countBy(SiteMember, { siteId: data.corrick.site.id })).toBe(
      1,
    );
  });

  it("[UC-SR-52] refuses to give a Corrick member one of Bakery's roles", async () => {
    const m = dataSource.manager;
    const crossSite = m.create(SiteMember, {
      siteId: data.corrick.site.id,
      userId: data.user.id,
      roleId: data.bakery.editor.id,
    });

    const error = await m.save(crossSite).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(QueryFailedError);
    expect(
      (error as QueryFailedError<Error & { constraint?: string }>).driverError
        .constraint,
    ).toBe('site_members_site_id_role_id_fkey');
  });
});
