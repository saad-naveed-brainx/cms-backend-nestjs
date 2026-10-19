import type { INestApplication } from '@nestjs/common';
import { readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import request from 'supertest';
import type { DataSource, MigrationInterface } from 'typeorm';
import { Permission } from '../src/auth/permission.js';
import { ProvisioningService } from '../src/provisioning/provisioning.service.js';
import { createTestApp } from './support/app.js';
import { resetDatabase } from './support/database.js';
import { addMember } from './support/members.js';
import { seedPage } from './support/seed.js';

/**
 * Users and roles, T1 (`docs/features/users-roles/`): every site has the five roles, Authors publish
 * only their own pages, and page list rows name their author. Real Postgres, real provisioning, real
 * sign-ins; nothing is mocked. Every name, address and password is this file's own.
 */

// Provisioning hashes with production-cost scrypt (about 0.2 s each).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

/** The plan's role table (D1), written out here so the test does not borrow the code's own list. */
const EXPECTED_ROLES: Record<string, string[]> = {
  Administrator: [...Object.values(Permission), 'content.publish_own'],
  Editor: [
    'content.create',
    'content.edit_own',
    'content.edit_any',
    'content.publish',
    'content.delete',
    'media.upload',
    'media.delete',
    'terms.manage',
    'menus.manage',
    'redirects.manage',
    'forms.view',
  ],
  Author: [
    'content.create',
    'content.edit_own',
    'content.publish_own',
    'media.upload',
  ],
  Contributor: ['content.create', 'content.edit_own'],
  Viewer: [],
};
const ROLE_NAMES = [
  'Administrator',
  'Editor',
  'Author',
  'Contributor',
  'Viewer',
];

/** A set's worth of sorted, de-duplicated values, so order and repeats do not matter. */
const asSet = (values: readonly string[]) => [...new Set(values)].sort();
const expectedRoles = () =>
  Object.fromEntries(
    Object.entries(EXPECTED_ROLES).map(([name, perms]) => [name, asSet(perms)]),
  );

let app: INestApplication;
let dataSource: DataSource;
const api = () => request(app.getHttpServer());

beforeAll(async () => {
  ({ app, dataSource } = await createTestApp());
  // Listening on a loopback port keeps supertest from opening and closing a listener of its own per call.
  await app.listen(0, '127.0.0.1');
});

beforeEach(async () => {
  await resetDatabase(dataSource);
});

afterAll(async () => {
  await app.close();
});

/** A client made by the real provisioning service, its admin signed in for real. */
async function newClient(prefix: string, adminName: string) {
  const password = `${prefix}-admin-password`;
  const tenant = await app.get(ProvisioningService).provisionTenant({
    organizationName: `${adminName} Holdings`,
    siteName: `${adminName} Site`,
    hostnames: [`${prefix}.test`],
    admin: { email: `${prefix}@${prefix}.test`, name: adminName, password },
  });
  const login = await api()
    .post('/auth/login')
    .send({ email: `${prefix}@${prefix}.test`, password })
    .expect(200);
  const token = login.body.accessToken as string;
  return {
    siteId: tenant.site.id,
    userId: tenant.admin.id,
    token,
    headers: { Authorization: `Bearer ${token}`, 'X-Site-Id': tenant.site.id },
  };
}

/** A site's roles as `{ name: sorted permissions }`. */
async function rolesOf(siteId: string): Promise<Record<string, string[]>> {
  const rows = await dataSource.query<
    { name: string; permissions: string[] }[]
  >(
    'SELECT name, permissions::text[] AS permissions FROM roles WHERE site_id = $1',
    [siteId],
  );
  return Object.fromEntries(
    rows.map((row) => [row.name, [...row.permissions].sort()]),
  );
}

/** Who holds which role on a site: `[user id, role id, role name]`, by user id. */
async function membersOf(siteId: string) {
  return dataSource.query<{ user_id: string; role_id: string; name: string }[]>(
    `SELECT m.user_id, m.role_id, r.name
       FROM site_members m JOIN roles r ON r.id = m.role_id
      WHERE m.site_id = $1 ORDER BY m.user_id`,
    [siteId],
  );
}

describe('every site has the five roles', () => {
  it('[UC-UR-01] a site created with POST /sites (and one made by the seed path) has exactly the five roles with the plan permissions, and its creator is Administrator', async () => {
    const olivia = await newClient('olivia', 'Olivia Orchard');

    const res = await api()
      .post('/sites')
      .set({ Authorization: olivia.headers.Authorization })
      .send({ name: 'Orchard Cafe', hostnames: ['cafe.test'] })
      .expect(201);
    const cafeId = res.body.site.id as string;

    // The site made from the admin, and the first site the seed path made: the same five roles.
    for (const siteId of [cafeId, olivia.siteId]) {
      expect(await rolesOf(siteId), siteId).toEqual(expectedRoles());
      expect((await rolesOf(siteId)).Administrator, siteId).toContain(
        'content.publish_own',
      );
      // Olivia is the one member, as Administrator.
      expect(
        (await membersOf(siteId)).map((row) => [row.user_id, row.name]),
        siteId,
      ).toEqual([[olivia.userId, 'Administrator']]);
    }
    expect(res.body.membership.role.name).toBe('Administrator');
    expect(asSet(res.body.membership.permissions)).toEqual(
      asSet(EXPECTED_ROLES.Administrator),
    );

    // The code's one list of roles (contract: `src/auth/roles.ts`) names them in the plan's order.
    const { ROLE_DEFINITIONS } = (await import('../src/auth/roles.js')) as {
      ROLE_DEFINITIONS: readonly {
        name: string;
        permissions: readonly string[];
      }[];
    };
    expect(ROLE_DEFINITIONS.map((role) => role.name)).toEqual(ROLE_NAMES);
    expect(
      Object.fromEntries(
        ROLE_DEFINITIONS.map((role) => [role.name, asSet(role.permissions)]),
      ),
    ).toEqual(expectedRoles());
  });
});

describe('the roles migration', () => {
  const migrationsDir = fileURLToPath(
    new URL('../src/database/migrations/', import.meta.url),
  );

  /** The one migration class in the `*-AddFiveRoles.ts` file. */
  async function loadAddFiveRoles(): Promise<new () => MigrationInterface> {
    const files = readdirSync(migrationsDir).filter((file) =>
      file.endsWith('-AddFiveRoles.ts'),
    );
    expect(files, 'one migration file ending in -AddFiveRoles.ts').toHaveLength(
      1,
    );
    const module = (await import(
      pathToFileURL(`${migrationsDir}${files[0]}`).href
    )) as Record<string, unknown>;
    const classes = Object.values(module).filter(
      (value) => typeof value === 'function',
    );
    expect(classes, 'the file exports exactly one class').toHaveLength(1);
    return classes[0] as new () => MigrationInterface;
  }

  async function runUp(Migration: new () => MigrationInterface) {
    const runner = dataSource.createQueryRunner();
    try {
      await new Migration().up(runner);
    } finally {
      await runner.release();
    }
  }

  /** Every stored value that the migration must not touch, or must touch only as the plan says. */
  async function snapshot() {
    return {
      roles: await dataSource.query(
        'SELECT id, site_id, name, permissions::text[] AS permissions, created_at, updated_at FROM roles ORDER BY site_id, name',
      ),
      members: await dataSource.query(
        'SELECT * FROM site_members ORDER BY site_id, user_id',
      ),
      content: await dataSource.query('SELECT * FROM content ORDER BY id'),
    };
  }

  it('[UC-UR-02] gives a site made before the feature the four new roles and publish_own for its Administrator, keeps its member and pages, touches no other site, and changes nothing when run again', async () => {
    const old = await newClient('olga', 'Olga Old');
    const untouched = await newClient('nina', 'Nina New');
    const [pageType] = await dataSource.query<{ id: string }[]>(
      "SELECT id FROM content_types WHERE site_id = $1 AND slug = 'page'",
      [old.siteId],
    );
    await seedPage(dataSource, {
      siteId: old.siteId,
      contentTypeId: pageType.id,
      title: 'Our story',
      slug: 'story',
      path: '/story',
      createdBy: old.userId,
    });

    // Put the old site back in the shape sites had before this feature: one Administrator role,
    // without content.publish_own (written so it also works before that value exists).
    await dataSource.query(
      "DELETE FROM roles WHERE site_id = $1 AND name <> 'Administrator'",
      [old.siteId],
    );
    await dataSource.query(
      `UPDATE roles
          SET permissions = ARRAY(SELECT p FROM unnest(permissions) AS p
                                   WHERE p::text <> 'content.publish_own')
        WHERE site_id = $1`,
      [old.siteId],
    );
    const oldRoles = await rolesOf(old.siteId);
    expect(Object.keys(oldRoles)).toEqual(['Administrator']);
    expect(oldRoles.Administrator).not.toContain('content.publish_own');
    const before = await snapshot();
    const oldMembersBefore = await membersOf(old.siteId);
    const oldAdminRole = before.roles.find(
      (row: { site_id: string; name: string }) =>
        row.site_id === old.siteId && row.name === 'Administrator',
    );

    const Migration = await loadAddFiveRoles();
    await runUp(Migration);

    // The old site: five roles with the plan's permissions, Administrator now with publish_own.
    expect(await rolesOf(old.siteId)).toEqual(expectedRoles());
    expect((await rolesOf(old.siteId)).Administrator).toContain(
      'content.publish_own',
    );
    // The same Administrator row (not a new one), still held by the same member.
    const after = await snapshot();
    const oldAdminAfter = after.roles.find(
      (row: { site_id: string; name: string }) =>
        row.site_id === old.siteId && row.name === 'Administrator',
    );
    expect(oldAdminAfter.id).toBe(oldAdminRole.id);
    expect(await membersOf(old.siteId)).toEqual(oldMembersBefore);
    expect(oldMembersBefore.map((row) => row.name)).toEqual(['Administrator']);
    // Memberships and pages, of both sites, exactly as they were.
    expect(after.members).toEqual(before.members);
    expect(after.content).toEqual(before.content);
    // The untouched site's roles are row for row what they were.
    const rolesOfSite = (rows: { site_id: string }[], siteId: string) =>
      rows.filter((row) => row.site_id === siteId);
    expect(rolesOfSite(after.roles, untouched.siteId)).toEqual(
      rolesOfSite(before.roles, untouched.siteId),
    );

    // A second run changes nothing at all.
    await runUp(Migration);
    expect(await snapshot()).toEqual(after);
  });
});

describe('publishing your own pages', () => {
  const act = (
    action: 'publish' | 'unpublish',
    who: { headers: Record<string, string> },
    id: string,
  ) => api().post(`/content/${id}/${action}`).set(who.headers);

  const statusOf = async (id: string) =>
    (
      await dataSource.query<{ status: string }[]>(
        'SELECT status FROM content WHERE id = $1',
        [id],
      )
    )[0].status;

  const newDraft = async (
    who: { headers: Record<string, string> },
    slug: string,
  ) =>
    (
      await api()
        .post('/content')
        .set(who.headers)
        .send({ type: 'page', title: `Title ${slug}`, slug })
        .expect(201)
    ).body.id as string;

  it('[UC-UR-03] an Author publishes and unpublishes only their own page, an Editor any page, and a Contributor none; a refused page stays as it was', async () => {
    const olivia = await newClient('olivia', 'Olivia Orchard');
    const siteId = olivia.siteId;
    const arthur = await addMember(app, siteId, {
      email: 'arthur@orchard.test',
      name: 'Arthur Author',
      role: 'Author',
    });
    const eddie = await addMember(app, siteId, {
      email: 'eddie@orchard.test',
      name: 'Eddie Editor',
      role: 'Editor',
    });
    const cora = await addMember(app, siteId, {
      email: 'cora@orchard.test',
      name: 'Cora Contributor',
      role: 'Contributor',
    });

    const arthursPage = await newDraft(arthur, 'arthurs-page');
    const eddiesPage = await newDraft(eddie, 'eddies-page');
    const corasPage = await newDraft(cora, 'coras-page');

    // Arthur, on his own page: allowed both ways.
    await act('publish', arthur, arthursPage).expect(200);
    expect(await statusOf(arthursPage)).toBe('published');
    await act('unpublish', arthur, arthursPage).expect(200);
    expect(await statusOf(arthursPage)).toBe('draft');

    // Arthur, on Eddie's page: refused both ways, and the page stays as it was.
    await act('publish', arthur, eddiesPage).expect(403);
    expect(await statusOf(eddiesPage)).toBe('draft');
    await act('publish', eddie, eddiesPage).expect(200);
    await act('unpublish', arthur, eddiesPage).expect(403);
    expect(await statusOf(eddiesPage)).toBe('published');

    // Eddie, on his own page and on Arthur's: allowed both ways.
    await act('unpublish', eddie, eddiesPage).expect(200);
    expect(await statusOf(eddiesPage)).toBe('draft');
    await act('publish', eddie, arthursPage).expect(200);
    expect(await statusOf(arthursPage)).toBe('published');
    await act('unpublish', eddie, arthursPage).expect(200);
    expect(await statusOf(arthursPage)).toBe('draft');

    // Cora, on her own page: refused both ways.
    await act('publish', cora, corasPage).expect(403);
    expect(await statusOf(corasPage)).toBe('draft');
    await act('publish', eddie, corasPage).expect(200);
    await act('unpublish', cora, corasPage).expect(403);
    expect(await statusOf(corasPage)).toBe('published');
  });
});

describe('page authors in the list', () => {
  it('[UC-UR-04] each page list row names its author, a removed member included; a deleted account is null; no other site, email or password hash appears', async () => {
    const olivia = await newClient('olivia', 'Olivia Orchard');
    const mark = await newClient('mark', 'Mark Maple');
    const siteId = olivia.siteId;
    await dataSource.query('DELETE FROM content');

    // Sara and Otto are added on the one role every site has had from the start.
    const sara = await addMember(app, siteId, {
      email: 'sara@orchard.test',
      name: 'Sara Sample',
      role: 'Administrator',
    });
    const otto = await addMember(app, siteId, {
      email: 'otto@orchard.test',
      name: 'Otto Gone',
      role: 'Administrator',
    });
    const page = (who: { headers: Record<string, string> }, slug: string) =>
      api()
        .post('/content')
        .set(who.headers)
        .send({ type: 'page', title: `Title ${slug}`, slug })
        .expect(201)
        .then((res) => res.body.id as string);
    const oliviasPage = await page(olivia, 'olivias-page');
    const sarasPage = await page(sara, 'saras-page');
    const ottosPage = await page(otto, 'ottos-page');
    await page(mark, 'marks-page');

    // Sara is removed from the site; Otto's account is deleted altogether.
    await dataSource.query(
      'DELETE FROM site_members WHERE site_id = $1 AND user_id = $2',
      [siteId, sara.userId],
    );
    await dataSource.query('DELETE FROM users WHERE id = $1', [otto.userId]);

    const res = await api().get('/content').set(olivia.headers).expect(200);
    const items = res.body.items as { id: string; author?: unknown }[];
    const byId = Object.fromEntries(items.map((item) => [item.id, item]));

    expect(Object.keys(byId).sort()).toEqual(
      [oliviasPage, sarasPage, ottosPage].sort(),
    );
    expect(byId[oliviasPage].author).toEqual({
      id: olivia.userId,
      name: 'Olivia Orchard',
    });
    expect(byId[sarasPage].author).toEqual({
      id: sara.userId,
      name: 'Sara Sample',
    });
    expect(byId[ottosPage]).toHaveProperty('author', null);

    // Nothing about anyone else, and no email or password hash, anywhere in the answer.
    const text = JSON.stringify(res.body);
    for (const leak of [
      mark.userId,
      'Mark Maple',
      '@orchard.test',
      '@mark.test',
      '@olivia.test',
      'scrypt$',
      'passwordHash',
      'password_hash',
      '"email"',
    ]) {
      expect(text, leak).not.toContain(leak);
    }
  });
});
