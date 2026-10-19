import type { INestApplication } from '@nestjs/common';
import sharp from 'sharp';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { ProvisioningService } from '../src/provisioning/provisioning.service.js';
import { createTestApp } from './support/app.js';
import { resetDatabase } from './support/database.js';
import { addMember } from './support/members.js';

/**
 * Users and roles, T2 (`docs/features/users-roles/`): the members routes (list, change a role,
 * remove), the two safety rules (the last Administrator, the organisation's owner), changes taking
 * effect at the person's next request, the upper-case site id, and the brief's role table end to
 * end. Real Postgres, real provisioning, real sign-ins; nothing is mocked.
 */

// Provisioning hashes with production-cost scrypt (about 0.2 s each).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const LAST_ADMIN = 'A site needs at least one Administrator.';
const OWNER_STAYS = "The organisation's owner stays an Administrator.";

type Who = { headers: Record<string, string> };

let app: INestApplication;
let dataSource: DataSource;
const api = () => request(app.getHttpServer());

beforeAll(async () => {
  ({ app, dataSource } = await createTestApp());
  await app.listen(0, '127.0.0.1');
});

beforeEach(async () => {
  await resetDatabase(dataSource);
});

afterAll(async () => {
  await app.close();
});

/** A client made by the real provisioning service; its admin (the organisation's owner) signed in. */
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

/** A site's role id by name, read from the table (not from the route under test). */
async function roleId(siteId: string, name: string): Promise<string> {
  const [row] = await dataSource.query<{ id: string }[]>(
    'SELECT id FROM roles WHERE site_id = $1 AND name = $2',
    [siteId, name],
  );
  return row.id;
}

/** The role name a user holds on a site, or `undefined` when not a member. */
async function roleOf(
  siteId: string,
  userId: string,
): Promise<string | undefined> {
  const [row] = await dataSource.query<{ name: string }[]>(
    `SELECT r.name FROM site_members m JOIN roles r ON r.id = m.role_id
      WHERE m.site_id = $1 AND m.user_id = $2`,
    [siteId, userId],
  );
  return row?.name;
}

/** How many members of a site hold a role with `members.manage`. */
async function administratorCount(siteId: string): Promise<number> {
  const [row] = await dataSource.query<{ n: number }[]>(
    `SELECT count(*)::int AS n FROM site_members m JOIN roles r ON r.id = m.role_id
      WHERE m.site_id = $1 AND 'members.manage' = ANY(r.permissions::text[])`,
    [siteId],
  );
  return row.n;
}

const newDraft = async (who: Who, slug: string) =>
  (
    await api()
      .post('/content')
      .set(who.headers)
      .send({ type: 'page', title: `Title ${slug}`, slug })
      .expect(201)
  ).body.id as string;

const picture = () =>
  sharp({
    create: {
      width: 8,
      height: 8,
      channels: 3,
      background: { r: 200, g: 120, b: 40 },
    },
  })
    .png()
    .toBuffer();

describe('the site id header', () => {
  it('[UC-UR-05] an upper-case X-Site-Id is the same site: a role change and an upload made with it show up when asked with the lower-case id', async () => {
    const olivia = await newClient('olivia', 'Olivia Orchard');
    const sara = await addMember(app, olivia.siteId, {
      email: 'sara@orchard.test',
      name: 'Sara Sample',
      role: 'Editor',
    });
    const upper = {
      Authorization: olivia.headers.Authorization,
      'X-Site-Id': olivia.siteId.toUpperCase(),
    };
    expect(upper['X-Site-Id']).not.toBe(olivia.siteId);

    // Change Sara's role with the upper-case id.
    const changed = await api()
      .patch(`/members/${sara.userId}`)
      .set(upper)
      .send({ roleId: await roleId(olivia.siteId, 'Author') })
      .expect(200);
    expect(changed.body.role.name).toBe('Author');

    // Upload a picture with the upper-case id.
    const uploaded = await api()
      .post('/media')
      .set(upper)
      .attach('file', await picture(), 'upper.png')
      .expect(201);

    // Asked again with the lower-case id: both are there, filed under the one (lower-case) site.
    const members = await api().get('/members').set(olivia.headers).expect(200);
    const saraRow = (
      members.body.members as { userId: string; role: { name: string } }[]
    ).find((m) => m.userId === sara.userId);
    expect(saraRow?.role.name).toBe('Author');

    const media = await api().get('/media').set(olivia.headers).expect(200);
    const listed = (media.body.items as { id: string; url: string }[]).find(
      (item) => item.id === uploaded.body.id,
    );
    expect(listed).toBeDefined();
    expect(listed?.url).toContain(`/${olivia.siteId}/`);
    expect(uploaded.body.url).toContain(`/${olivia.siteId}/`);
  });
});

describe('changes apply at the next request', () => {
  it('[UC-UR-08] demoting Sara stops her publishing at once; removing her shuts her out of site A only, keeps her account, site B and her page', async () => {
    const olivia = await newClient('olivia', 'Olivia Orchard');
    const mark = await newClient('mark', 'Mark Maple');
    const sara = await addMember(app, olivia.siteId, {
      email: 'sara@orchard.test',
      name: 'Sara Sample',
      role: 'Editor',
    });
    // Sara is also an Editor on Mark's site (site B), with the same account.
    await dataSource.query(
      'INSERT INTO site_members (site_id, user_id, role_id) VALUES ($1, $2, $3)',
      [mark.siteId, sara.userId, await roleId(mark.siteId, 'Editor')],
    );
    const saraOnB = {
      headers: {
        Authorization: `Bearer ${sara.token}`,
        'X-Site-Id': mark.siteId,
      },
    };
    const sarasPage = await newDraft(sara, 'saras-page');

    // Olivia makes her a Contributor; Sara's next publish (same token) is refused.
    const changed = await api()
      .patch(`/members/${sara.userId}`)
      .set(olivia.headers)
      .send({ roleId: await roleId(olivia.siteId, 'Contributor') })
      .expect(200);
    expect(changed.body).toMatchObject({
      userId: sara.userId,
      name: 'Sara Sample',
      email: 'sara@orchard.test',
      role: { name: 'Contributor' },
      isOwner: false,
    });
    await api()
      .post(`/content/${sarasPage}/publish`)
      .set(sara.headers)
      .expect(403);

    // Olivia removes her; Sara's next request for site A is refused.
    await api()
      .delete(`/members/${sara.userId}`)
      .set(olivia.headers)
      .expect(204);
    await api().get('/content').set(sara.headers).expect(403);

    // Her profile no longer lists site A, still lists site B, and site B still works.
    const me = await api()
      .get('/auth/me')
      .set({ Authorization: `Bearer ${sara.token}` })
      .expect(200);
    const siteIds = (me.body.memberships as { site: { id: string } }[]).map(
      (m) => m.site.id,
    );
    expect(siteIds).toEqual([mark.siteId]);
    await api().get('/content').set(saraOnB.headers).expect(200);

    // Her account still exists; her page is still on site A, with her as author.
    const users = await dataSource.query('SELECT id FROM users WHERE id = $1', [
      sara.userId,
    ]);
    expect(users).toHaveLength(1);
    const list = await api().get('/content').set(olivia.headers).expect(200);
    const row = (list.body.items as { id: string; author: unknown }[]).find(
      (item) => item.id === sarasPage,
    );
    expect(row?.author).toEqual({ id: sara.userId, name: 'Sara Sample' });
  });
});

describe('the last Administrator and the owner', () => {
  it('[UC-UR-14] the owner cannot be demoted or removed, by others or herself; Ada can be demoted; on a site with two non-owner Administrators, of two simultaneous demotions exactly one succeeds', async () => {
    const olivia = await newClient('olivia', 'Olivia Orchard');
    const siteId = olivia.siteId;
    const ada = await addMember(app, siteId, {
      email: 'ada@orchard.test',
      name: 'Ada Admin',
      role: 'Administrator',
    });
    const editorRole = await roleId(siteId, 'Editor');

    // Ada tries to demote, then remove, Olivia (the owner).
    const demoteOwner = await api()
      .patch(`/members/${olivia.userId}`)
      .set(ada.headers)
      .send({ roleId: editorRole })
      .expect(409);
    expect(demoteOwner.body.message).toBe(OWNER_STAYS);
    const removeOwner = await api()
      .delete(`/members/${olivia.userId}`)
      .set(ada.headers)
      .expect(409);
    expect(removeOwner.body.message).toBe(OWNER_STAYS);
    expect(await roleOf(siteId, olivia.userId)).toBe('Administrator');

    // Olivia demotes Ada.
    await api()
      .patch(`/members/${ada.userId}`)
      .set(olivia.headers)
      .send({ roleId: editorRole })
      .expect(200);
    expect(await roleOf(siteId, ada.userId)).toBe('Editor');

    // Olivia, now the only Administrator and the owner, cannot demote or remove herself.
    await api()
      .patch(`/members/${olivia.userId}`)
      .set(olivia.headers)
      .send({ roleId: editorRole })
      .expect(409);
    await api()
      .delete(`/members/${olivia.userId}`)
      .set(olivia.headers)
      .expect(409);
    expect(await roleOf(siteId, olivia.userId)).toBe('Administrator');

    // Another site of Olivia's organisation, run by two Administrators who are not the owner.
    const cafe = await api()
      .post('/sites')
      .set({ Authorization: olivia.headers.Authorization })
      .send({ name: 'Orchard Cafe', hostnames: ['cafe.test'] })
      .expect(201);
    const cafeId = cafe.body.site.id as string;
    const bea = await addMember(app, cafeId, {
      email: 'bea@cafe.test',
      name: 'Bea Boss',
      role: 'Administrator',
    });
    const cal = await addMember(app, cafeId, {
      email: 'cal@cafe.test',
      name: 'Cal Chief',
      role: 'Administrator',
    });
    await dataSource.query(
      'DELETE FROM site_members WHERE site_id = $1 AND user_id = $2',
      [cafeId, olivia.userId],
    );
    expect(await administratorCount(cafeId)).toBe(2);
    const cafeEditor = await roleId(cafeId, 'Editor');

    const [beaDemotesCal, calDemotesBea] = await Promise.all([
      api()
        .patch(`/members/${cal.userId}`)
        .set(bea.headers)
        .send({ roleId: cafeEditor }),
      api()
        .patch(`/members/${bea.userId}`)
        .set(cal.headers)
        .send({ roleId: cafeEditor }),
    ]);
    const outcomes = [beaDemotesCal, calDemotesBea];
    // Exactly one wins. The other is refused: normally a 409 from the locked transaction, but a 403
    // if the winner committed before the loser's permission check ran (the loser is an Editor by then).
    const winners = outcomes.filter((res) => res.status === 200);
    const losers = outcomes.filter((res) => res.status !== 200);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    const [loser] = losers;
    expect([403, 409]).toContain(loser.status);
    if (loser.status === 409) expect(loser.body.message).toBe(LAST_ADMIN);
    expect(await administratorCount(cafeId)).toBe(1);
  });
});

describe("the brief's role table", () => {
  type Action =
    | 'create page'
    | 'edit own'
    | 'edit others'
    | 'publish own'
    | 'publish others'
    | 'upload picture'
    | 'save appearance'
    | 'make content type'
    | 'list members'
    | 'read pages'
    | 'preview';
  const ACTIONS: Action[] = [
    'create page',
    'edit own',
    'edit others',
    'publish own',
    'publish others',
    'upload picture',
    'save appearance',
    'make content type',
    'list members',
    'read pages',
    'preview',
  ];
  type Role = 'Administrator' | 'Editor' | 'Author' | 'Contributor' | 'Viewer';
  type Cell = 'allowed' | 'refused' | 'n/a';

  /** The brief's table, written out here so the test does not borrow the code's own list. */
  const allowedFor: Record<Role, Action[]> = {
    Administrator: ACTIONS,
    Editor: ACTIONS.filter(
      (a) =>
        a !== 'save appearance' &&
        a !== 'make content type' &&
        a !== 'list members',
    ),
    Author: [
      'create page',
      'edit own',
      'publish own',
      'upload picture',
      'read pages',
      'preview',
    ],
    Contributor: ['create page', 'edit own', 'read pages', 'preview'],
    Viewer: ['read pages', 'preview'],
  };
  const expected = (role: Role): Record<Action, Cell> =>
    Object.fromEntries(
      ACTIONS.map((a) => [
        a,
        role === 'Viewer' && (a === 'edit own' || a === 'publish own')
          ? 'n/a'
          : allowedFor[role].includes(a)
            ? 'allowed'
            : 'refused',
      ]),
    ) as Record<Action, Cell>;

  it('[UC-UR-16] each of the five roles can do exactly what the table says, and every refusal is a 403', async () => {
    const olivia = await newClient('olivia', 'Olivia Orchard');
    const siteId = olivia.siteId;
    const roles: Role[] = [
      'Administrator',
      'Editor',
      'Author',
      'Contributor',
      'Viewer',
    ];

    const actual: Record<string, Record<string, Cell | string>> = {};
    const want: Record<string, Record<string, Cell>> = {};
    for (const role of roles) {
      const key = role.toLowerCase();
      const who = await addMember(app, siteId, {
        email: `${key}@orchard.test`,
        name: `${role} Person`,
        role,
      });
      // Pages of someone else's (the owner's), one to edit and one to publish, fresh per role.
      const othersPage = await newDraft(olivia, `others-${key}`);
      const othersToPublish = await newDraft(olivia, `others-pub-${key}`);

      const cells: Record<string, Cell | string> = {};
      /** `allowed` for the given success status, `refused` for a 403, the status otherwise. */
      const judge = (action: Action, status: number, ok: number) => {
        cells[action] =
          status === ok
            ? 'allowed'
            : status === 403
              ? 'refused'
              : `HTTP ${status}`;
      };

      const created = await api()
        .post('/content')
        .set(who.headers)
        .send({ type: 'page', title: `Own ${key}`, slug: `own-${key}` });
      judge('create page', created.status, 201);
      const ownPage =
        created.status === 201 ? (created.body.id as string) : undefined;

      if (ownPage) {
        const editOwn = await api()
          .patch(`/content/${ownPage}`)
          .set(who.headers)
          .send({ title: `Own ${key} edited` });
        judge('edit own', editOwn.status, 200);
      } else {
        cells['edit own'] = 'n/a';
      }

      const editOthers = await api()
        .patch(`/content/${othersPage}`)
        .set(who.headers)
        .send({ title: `Others ${key} edited` });
      judge('edit others', editOthers.status, 200);

      if (ownPage) {
        const publishOwn = await api()
          .post(`/content/${ownPage}/publish`)
          .set(who.headers);
        judge('publish own', publishOwn.status, 200);
      } else {
        cells['publish own'] = 'n/a';
      }

      const publishOthers = await api()
        .post(`/content/${othersToPublish}/publish`)
        .set(who.headers);
      judge('publish others', publishOthers.status, 200);

      const upload = await api()
        .post('/media')
        .set(who.headers)
        .attach('file', await picture(), `${key}.png`);
      judge('upload picture', upload.status, 201);

      const appearance = await api()
        .patch('/appearance')
        .set(who.headers)
        .send({ tagline: `Tagline by ${key}` });
      judge('save appearance', appearance.status, 200);

      const contentType = await api()
        .post('/content-types')
        .set(who.headers)
        .send({ name: `Type ${key}`, urlPrefix: `/type-${key}` });
      judge('make content type', contentType.status, 201);

      const members = await api().get('/members').set(who.headers);
      judge('list members', members.status, 200);

      const read = await api().get('/content').set(who.headers);
      judge('read pages', read.status, 200);

      const preview = await api()
        .post(`/content/${othersPage}/preview`)
        .set(who.headers);
      judge('preview', preview.status, 200);

      actual[role] = cells;
      want[role] = expected(role);
    }

    expect(actual).toEqual(want);
  });
});
