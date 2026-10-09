import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { Permission } from '../../src/auth/permission.js';
import { ProvisioningService } from '../../src/provisioning/provisioning.service.js';
import { createTestApp } from './app.js';
import { resetDatabase } from './database.js';
import { TEST_PASSWORD, seedMembership, seedRole, seedUser } from './seed.js';

/**
 * A small world for the tests of the content routes and what is built on them: two clients made by
 * the real provisioning service, people who sign in with the real login, and `Authorization` plus
 * `X-Site-Id` ready on each. Nothing is mocked. Names, addresses and passwords are this file's own.
 */

export type Who = {
  userId: string;
  headers: { Authorization: string; 'X-Site-Id': string };
};

export type ContentWorld = {
  app: INestApplication;
  dataSource: DataSource;
  api: () => ReturnType<typeof request>;
  orchard: {
    siteId: string;
    admin: Who;
    author: Who;
    editor: Who;
    viewer: Who;
    /** Holds `content.publish` and nothing else. */
    publisher: Who;
  };
  maple: { siteId: string; admin: Who };
  /** A page made through the real route; fails the test if it is not a 201. */
  newPage: (
    who: Who,
    slug: string,
    extra?: object,
  ) => Promise<Record<string, any>>;
  close: () => Promise<void>;
};

export async function buildContentWorld(): Promise<ContentWorld> {
  const { app, dataSource } = await createTestApp();
  // Listening on a loopback port keeps supertest from opening and closing a listener of its own per call.
  await app.listen(0, '127.0.0.1');
  await resetDatabase(dataSource);
  const api = () => request(app.getHttpServer());

  async function signIn(
    email: string,
    password: string,
    siteId: string,
  ): Promise<Who> {
    const res = await api()
      .post('/auth/login')
      .send({ email, password })
      .expect(200);
    return {
      userId: res.body.user.id,
      headers: {
        Authorization: `Bearer ${res.body.accessToken}`,
        'X-Site-Id': siteId,
      },
    };
  }

  /** A person who really signs in, on a role with exactly these permissions. */
  async function addMember(
    siteId: string,
    email: string,
    roleName: string,
    permissions: Permission[],
  ): Promise<Who> {
    const user = await seedUser(dataSource, {
      email,
      name: `${roleName} Person`,
      password: TEST_PASSWORD,
    });
    const role = await seedRole(dataSource, {
      siteId,
      name: roleName,
      permissions,
    });
    await seedMembership(dataSource, {
      siteId,
      userId: user.id,
      roleId: role.id,
    });
    return signIn(email, TEST_PASSWORD, siteId);
  }

  const provisioning = app.get(ProvisioningService);
  const orchardTenant = await provisioning.provisionTenant({
    organizationName: 'Orchard Holdings',
    siteName: 'Orchard Bakery',
    hostnames: ['orchard.test'],
    admin: {
      email: 'olivia@orchard.test',
      name: 'Olivia Orchard',
      password: 'orchard-admin-password',
    },
  });
  const mapleTenant = await provisioning.provisionTenant({
    organizationName: 'Maple Group',
    siteName: 'Maple Books',
    hostnames: ['maple.test'],
    admin: {
      email: 'mark@maple.test',
      name: 'Mark Maple',
      password: 'maple-admin-password',
    },
  });

  const orchardId = orchardTenant.site.id;
  const orchard = {
    siteId: orchardId,
    admin: await signIn(
      'olivia@orchard.test',
      'orchard-admin-password',
      orchardId,
    ),
    author: await addMember(orchardId, 'ada@orchard.test', 'Author', [
      Permission.ContentCreate,
      Permission.ContentEditOwn,
    ]),
    editor: await addMember(orchardId, 'eli@orchard.test', 'Editor', [
      Permission.ContentCreate,
      Permission.ContentEditAny,
    ]),
    viewer: await addMember(orchardId, 'vic@orchard.test', 'Viewer', []),
    publisher: await addMember(orchardId, 'pat@orchard.test', 'Publisher', [
      Permission.ContentPublish,
    ]),
  };
  const maple = {
    siteId: mapleTenant.site.id,
    admin: await signIn(
      'mark@maple.test',
      'maple-admin-password',
      mapleTenant.site.id,
    ),
  };

  async function newPage(who: Who, slug: string, extra: object = {}) {
    const res = await api()
      .post('/content')
      .set(who.headers)
      .send({ type: 'page', title: `Title ${slug}`, slug, ...extra })
      .expect(201);
    return res.body;
  }

  return {
    app,
    dataSource,
    api,
    orchard,
    maple,
    newPage,
    close: () => app.close(),
  };
}
