import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import type { RoleName } from '../../src/auth/roles.js';
import { TEST_PASSWORD, seedMembership, seedUser } from './seed.js';

/**
 * Adding a person to a site with one of the site's own five roles (users-roles T1), before there is
 * a route for it (T2 adds one). The user is written straight to the table with a real password hash,
 * the membership points at the site's role of that name, and the person then signs in for real
 * with `POST /auth/login`, so what comes back is a token the app itself issued.
 */

export type Member = {
  userId: string;
  token: string;
  /** `Authorization` and `X-Site-Id` for the site the person was added to. */
  headers: { Authorization: string; 'X-Site-Id': string };
};

export async function addMember(
  app: INestApplication,
  siteId: string,
  person: { email: string; name: string; role: RoleName },
): Promise<Member> {
  const dataSource = app.get(DataSource);
  const [role] = await dataSource.query<{ id: string }[]>(
    'SELECT id FROM roles WHERE site_id = $1 AND name = $2',
    [siteId, person.role],
  );
  if (!role) {
    throw new Error(
      `addMember: site ${siteId} has no role named "${person.role}" (every site should have the five roles)`,
    );
  }
  const user = await seedUser(dataSource, {
    email: person.email,
    name: person.name,
    password: TEST_PASSWORD,
  });
  await seedMembership(dataSource, {
    siteId,
    userId: user.id,
    roleId: role.id,
  });

  const res = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email: person.email, password: TEST_PASSWORD })
    .expect(200);
  const token = res.body.accessToken as string;
  return {
    userId: user.id,
    token,
    headers: { Authorization: `Bearer ${token}`, 'X-Site-Id': siteId },
  };
}
