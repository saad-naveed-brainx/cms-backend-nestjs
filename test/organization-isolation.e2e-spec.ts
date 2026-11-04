import { randomUUID } from 'node:crypto';
import { invite, roleIdOf } from './support/invitations.js';
import { addMember } from './support/members.js';
import { seedVersion } from './support/seed.js';
import {
  buildWorld,
  fingerprint,
  ownedIds,
  type Side,
  type World,
} from './support/two-clients.js';

/**
 * Organizations, T5 (`docs/features/organizations/`, D-052, D-054): what the tenant isolation suite
 * proves between two clients, proved for the company layer. Real people, real tokens, real routes and
 * the real database; nothing is mocked. That the routes that came with organizations are in the
 * isolation suite's table, and are attacked by its sweeps, is that suite's own check (UC-TI-01, 03 to
 * 07): leaving one out fails it and names the route.
 *
 * - UC-OR-09: a person on one website of an organization has nothing on its other websites.
 * - UC-OR-10: one organization's owner cannot read, change or learn of another through the routes
 *   that came with organizations, and the other is unchanged.
 * - UC-OR-11: a person on two organizations is on each team with that organization's websites only.
 */

// Making the clients hashes passwords with production-cost scrypt (about 0.2 s each).
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let w: World;
/** Every id of one side's (website, rows, people, organization), for finding them in an answer meant for the other. */
let idsOf: Record<string, string[]>;

beforeAll(async () => {
  w = await buildWorld();
  const owned = async (side: Side) =>
    [
      ...(await ownedIds(w.dataSource, side.siteId)),
      side.mediaName,
      side.organizationId,
    ].filter((id) => id !== w.pat.userId);
  idsOf = { acorn: await owned(w.A), birch: await owned(w.B) };
});

afterAll(async () => {
  await w.close();
});

type Res = { status: number; body: any; text: string };
type Method = 'get' | 'post' | 'patch' | 'delete';

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function call(
  method: Method,
  path: string,
  headers: Record<string, string>,
  json?: object,
): Promise<Res> {
  let pending = w.api()[method](path).set(headers);
  if (json !== undefined) pending = pending.send(json);
  const res = await pending;
  return { status: res.status, body: res.body, text: res.text ?? '' };
}

/** `GET /organizations/:id/team` as the owner of `who`'s organization. */
const teamOf = (who: Side, id: string) =>
  call('get', `/organizations/${id}/team`, bearer(who.owner.token));

/** What a stranger can tell two answers apart by: the status and the message. */
const look = (res: Res) =>
  `${res.status} ${JSON.stringify(res.body?.message ?? null)}`;

/** What an answer says about the other side, if anything: its tag in any text, or one of its ids. */
function leakIn(res: Res, tag: string, ids: string[]): string | null {
  if (new RegExp(tag, 'i').test(res.text)) return `it mentions ${tag}`;
  const found = ids.find((id) => res.text.includes(id));
  return found ? `it contains ${found}, an id of ${tag}'s` : null;
}

// ---------------------------------------------------------------------------------------------
// UC-OR-11: one person on two organizations
// ---------------------------------------------------------------------------------------------

describe('a person on two organizations', () => {
  it("[UC-OR-11] is on each owner's team with that organization's website and role only, and neither owner learns of the other organization", async () => {
    // Pat is an Editor on Acorn's website and an Author on Birch's.
    const roleOf = (side: Side): 'Editor' | 'Author' =>
      side.tag === 'acorn' ? 'Editor' : 'Author';

    const me = await call('get', '/auth/me', bearer(w.pat.token));
    expect(me.status).toBe(200);
    expect(
      me.body.organizations.map((one: { id: string }) => one.id).sort(),
    ).toEqual([w.A.organizationId, w.B.organizationId].sort());

    for (const { mine, other } of [
      { mine: w.A, other: w.B },
      { mine: w.B, other: w.A },
    ]) {
      const label = `${mine.tag}'s owner reads ${mine.tag}'s team`;
      const res = await teamOf(mine, mine.organizationId);
      expect(res.status, label).toBe(200);

      // Its own website only, and Pat on it with its own role, and on nothing else.
      expect(
        res.body.websites.map((site: { id: string }) => site.id),
        label,
      ).toEqual([mine.siteId]);
      const pat = res.body.people.find(
        (one: { userId: string }) => one.userId === w.pat.userId,
      );
      expect(pat, label).toBeDefined();
      expect(pat.access, label).toEqual([
        {
          siteId: mine.siteId,
          role: {
            id: await roleIdOf(w.app, mine.siteId, roleOf(mine)),
            name: roleOf(mine),
          },
        },
      ]);

      // The waiting invitation is this organization's own.
      expect(
        res.body.invitations.map((one: { email: string }) => one.email),
        label,
      ).toEqual([mine.invitationEmail]);

      // Nothing of the other organization anywhere in the answer: its name, its website, its
      // roles, its people, its invitations or any of its ids.
      expect(leakIn(res, other.tag, idsOf[other.tag]), label).toBeNull();

      // Pat is a member of this organization's website, not its owner: told so, and nothing else.
      const asPat = await call(
        'get',
        `/organizations/${mine.organizationId}/team`,
        bearer(w.pat.token),
      );
      expect(asPat.status, `Pat reads ${mine.tag}'s team`).toBe(403);
      expect(leakIn(asPat, other.tag, idsOf[other.tag])).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// UC-OR-10: one organization's owner against another's
// ---------------------------------------------------------------------------------------------

/**
 * Everything about a side's organization that another organization's owner could change, as the
 * database and the owner's own screens show it: the organization's row, its websites, how many
 * organizations its owner has, the owner's list, the team, and the website's own rows.
 */
async function snapshot(side: Side) {
  const [organization] = await w.dataSource.query<{ h: string }[]>(
    'SELECT md5(t::text) AS h FROM organizations t WHERE t.id = $1',
    [side.organizationId],
  );
  const [sites] = await w.dataSource.query<{ n: number; h: string }[]>(
    `SELECT count(*)::int AS n, md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS h
       FROM sites t WHERE t.organization_id = $1`,
    [side.organizationId],
  );
  const [owned] = await w.dataSource.query<{ n: number }[]>(
    'SELECT count(*)::int AS n FROM organizations WHERE owner_id = $1',
    [side.owner.userId],
  );
  return {
    organization: organization?.h ?? 'gone',
    sites: `${sites.n} sites, ${sites.h}`,
    organizationsOwned: owned.n,
    list: (await call('get', '/organizations', bearer(side.owner.token))).body,
    team: (await teamOf(side, side.organizationId)).body,
    site: await fingerprint(w.dataSource, side.siteId),
  };
}

describe('one organization against another', () => {
  it("[UC-OR-10] the other organization's team is answered as an organization that is not there, nothing can be made for it, and it is unchanged", async () => {
    for (const { attacker, victim } of [
      { attacker: w.A, victim: w.B },
      { attacker: w.B, victim: w.A },
    ]) {
      const label = `${attacker.tag} against ${victim.tag}`;
      const before = await snapshot(victim);

      // The team: the other organization's id, in every spelling a person might try, is answered
      // exactly as an id that is not there, and says nothing of the organization.
      const absent = await teamOf(attacker, randomUUID());
      expect(absent.status, label).toBe(404);
      for (const [what, id] of [
        ['as it is', victim.organizationId],
        ['in capitals', victim.organizationId.toUpperCase()],
        ['with a letter too many', `${victim.organizationId}a`],
        ['as the id of its website', victim.siteId],
      ] as const) {
        const res = await teamOf(attacker, id);
        expect(look(res), `${label}: the id ${what}`).toBe(look(absent));
        expect(
          leakIn(res, victim.tag, idsOf[victim.tag]),
          `${label}: the id ${what}`,
        ).toBeNull();
      }

      // Making one: the other's owner or organization smuggled into the body is refused (the body
      // is strict), in the address it is ignored, and either way nothing is made for the victim.
      const own = (await snapshot(attacker)).organizationsOwned;
      for (const smuggled of [
        { ownerId: victim.owner.userId },
        { organizationId: victim.organizationId },
        { siteId: victim.siteId, site_id: victim.siteId },
      ]) {
        const res = await call(
          'post',
          '/organizations',
          bearer(attacker.owner.token),
          {
            name: `Hijack ${attacker.tag}`,
            ...smuggled,
          },
        );
        expect(res.status, `${label}: ${JSON.stringify(smuggled)}`).toBe(400);
      }
      expect((await snapshot(attacker)).organizationsOwned, label).toBe(own);
      const made = await call(
        'post',
        `/organizations?ownerId=${victim.owner.userId}&organizationId=${victim.organizationId}`,
        bearer(attacker.owner.token),
        { name: `Mine ${attacker.tag}` },
      );
      expect(made.status, label).toBe(201);
      const [row] = await w.dataSource.query<{ owner: string }[]>(
        'SELECT owner_id::text AS owner FROM organizations WHERE id = $1',
        [made.body.id],
      );
      expect(row.owner, `${label}: whose it is`).toBe(attacker.owner.userId);
      expect((await snapshot(attacker)).organizationsOwned, label).toBe(
        own + 1,
      );

      // Adding a website to the other organization is refused as it is for one that is not there.
      const site = (organizationId: string) =>
        call('post', '/sites', bearer(attacker.owner.token), {
          name: `Site of ${attacker.tag}`,
          hostnames: [`${randomUUID()}.test`],
          organizationId,
        });
      const refused = await site(victim.organizationId);
      expect(refused.status, label).toBeGreaterThanOrEqual(400);
      expect(look(refused), label).toBe(look(await site(randomUUID())));

      // Nothing about the victim changed, in the database or on its owner's own screens.
      expect(await snapshot(victim), label).toEqual(before);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// UC-OR-09: two websites of one organization
// ---------------------------------------------------------------------------------------------

/** What a request can be aimed at: one website's ids, or ids that exist nowhere. */
type Ids = {
  siteId: string;
  aboutId: string;
  draftId: string;
  memberId: string;
  roleId: string;
  invitationId: string;
  versionId: string;
};

const nowhere = (): Ids => ({
  siteId: randomUUID(),
  aboutId: randomUUID(),
  draftId: randomUUID(),
  memberId: randomUUID(),
  roleId: randomUUID(),
  invitationId: randomUUID(),
  versionId: randomUUID(),
});

/**
 * A second website in Acorn's organization, Pinecone Shop, made by Acorn's owner through the real
 * routes, with a published page, a draft, a picture, a member and a waiting invitation of its own.
 * Nothing in it says "acorn", so a leak of it into an answer for the first website can be found.
 */
async function addSibling() {
  const owner = w.A.owner;
  const made = await call('post', '/sites', bearer(owner.token), {
    name: 'Pinecone Shop',
    hostnames: ['pinecone.test'],
    organizationId: w.A.organizationId,
  });
  expect(made.status).toBe(201);
  const siteId: string = made.body.site.id;
  const headers = { ...bearer(owner.token), 'X-Site-Id': siteId };

  const page = async (title: string, slug: string) => {
    const res = await call('post', '/content', headers, {
      type: 'page',
      title,
      slug,
    });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };
  const aboutId = await page('Pinecone About', 'about');
  expect(
    (await call('post', `/content/${aboutId}/publish`, headers)).status,
  ).toBe(200);
  const draftId = await page('Pinecone Draft', 'draft');

  const picture = await w
    .api()
    .post('/media')
    .set(headers)
    .attach('file', w.picture, 'pinecone.png')
    .expect(201);
  const mediaName = String(picture.body.url).split('/').pop() as string;

  const member = await addMember(w.app, siteId, {
    email: 'writer@pinecone.test',
    name: 'Pinecone Writer',
    role: 'Author',
  });
  const invited = await invite(
    w.app,
    { headers },
    'newbie@pinecone.test',
    'Author',
  );

  // A version of its page, written straight (a save writes its own from version-history T2 on).
  const version = await seedVersion(w.dataSource, {
    siteId,
    contentId: aboutId,
    createdBy: owner.userId,
    snapshot: {
      title: 'Pinecone About',
      blocks: [],
      data: {},
      seoTitle: null,
      seoDescription: null,
      canonicalUrl: null,
      noIndex: false,
    },
  });

  const ids: Ids = {
    siteId,
    aboutId,
    draftId,
    memberId: member.userId,
    roleId: await roleIdOf(w.app, siteId, 'Author'),
    invitationId: invited.id,
    versionId: version.id,
  };
  // The owner is on both websites, so the owner's id is rightly in answers for either.
  const everyId = [...(await ownedIds(w.dataSource, siteId)), mediaName].filter(
    (id) => id !== owner.userId,
  );
  return { ids, everyId };
}

describe('two websites of one organization', () => {
  it('[UC-OR-09] a person on one website cannot reach, change or learn of the other, whatever their role', async () => {
    const shop = await addSibling();
    const fingerprintBefore = await fingerprint(w.dataSource, shop.ids.siteId);
    const leaks = (res: Res) => leakIn(res, 'pinecone', shop.everyId);

    // Sam is an Editor on Acorn's website only; Sue is its Administrator, who may manage people.
    const people = [
      {
        role: 'Editor',
        who: await addMember(w.app, w.A.siteId, {
          email: 'sam@acorn.test',
          name: 'Sam Acorn',
          role: 'Editor',
        }),
      },
      {
        role: 'Administrator',
        who: await addMember(w.app, w.A.siteId, {
          email: 'sue@acorn.test',
          name: 'Sue Acorn',
          role: 'Administrator',
        }),
      },
    ];

    for (const { role, who } of people) {
      const label = `${role} on the first website only`;
      const own = who.headers;

      // 1. The other website's id as the site header: refused as a website that is not there is.
      const doors: { method: Method; path: string; json?: object }[] = [
        { method: 'get', path: '/content' },
        {
          method: 'post',
          path: '/content',
          json: { type: 'page', title: 'Nope', slug: 'nope' },
        },
        { method: 'get', path: '/content-types' },
        { method: 'get', path: '/media' },
        { method: 'get', path: '/appearance' },
        { method: 'get', path: '/members' },
        { method: 'get', path: `/content/${w.A.aboutId}/versions` },
        {
          method: 'get',
          path: `/content/${w.A.aboutId}/versions/${w.A.versionId}`,
        },
      ];
      for (const door of doors) {
        const there = await call(
          door.method,
          door.path,
          { ...bearer(who.token), 'X-Site-Id': shop.ids.siteId },
          door.json,
        );
        const absent = await call(
          door.method,
          door.path,
          { ...bearer(who.token), 'X-Site-Id': randomUUID() },
          door.json,
        );
        const what = `${label}: ${door.method} ${door.path} with the other website's id as the header`;
        expect(there.status, what).toBe(403);
        expect(look(there), what).toBe(look(absent));
        expect(leaks(there), what).toBeNull();
      }

      // 2. The other website's page, member, role and invitation ids under one's own header:
      // refused (or not permitted) exactly as ids that are not there are, and never accepted.
      const byIds = (t: Ids) => [
        { method: 'get' as const, path: `/content/${t.aboutId}` },
        {
          method: 'patch' as const,
          path: `/content/${t.aboutId}`,
          json: { title: 'Hijacked' },
        },
        { method: 'post' as const, path: `/content/${t.draftId}/publish` },
        { method: 'post' as const, path: `/content/${t.aboutId}/unpublish` },
        { method: 'post' as const, path: `/content/${t.draftId}/preview` },
        { method: 'get' as const, path: `/content/${t.aboutId}/versions` },
        // The other website's version under one's own page: not that page's, so not found.
        {
          method: 'get' as const,
          path: `/content/${w.A.aboutId}/versions/${t.versionId}`,
        },
        {
          method: 'patch' as const,
          path: `/members/${t.memberId}`,
          json: { roleId: t.roleId },
        },
        { method: 'delete' as const, path: `/members/${t.memberId}` },
        {
          method: 'post' as const,
          path: `/invitations/${t.invitationId}/renew`,
        },
        { method: 'delete' as const, path: `/invitations/${t.invitationId}` },
      ];
      const theirs = byIds(shop.ids);
      const nothing = byIds(nowhere());
      for (const [at, door] of theirs.entries()) {
        const there = await call(door.method, door.path, own, door.json);
        const absent = await call(
          nothing[at].method,
          nothing[at].path,
          own,
          nothing[at].json,
        );
        const what = `${label}: ${door.method} ${door.path}`;
        expect(there.status, what).toBeGreaterThanOrEqual(400);
        expect(look(there), what).toBe(look(absent));
        expect(leaks(there), what).toBeNull();
      }

      // 3. Lists under one's own header show nothing of the other website.
      for (const path of [
        '/content',
        '/content-types',
        '/media',
        '/members',
        `/content/${w.A.aboutId}/versions`,
      ]) {
        const res = await call('get', path, own);
        expect(leaks(res), `${label}: ${path}`).toBeNull();
      }

      // 4. The other website's id smuggled into a body (strict, so refused), a form or the address
      // (ignored): whatever is made is the first website's own.
      const inBody = await call('post', '/content', own, {
        type: 'page',
        title: 'Smuggled',
        slug: `smuggled-body-${role.toLowerCase()}`,
        siteId: shop.ids.siteId,
        site_id: shop.ids.siteId,
      });
      expect(inBody.status, `${label}: in the body`).toBe(400);

      const inAddress = await call(
        'post',
        `/content?siteId=${shop.ids.siteId}&site_id=${shop.ids.siteId}`,
        own,
        {
          type: 'page',
          title: 'Smuggled',
          slug: `smuggled-address-${role.toLowerCase()}`,
        },
      );
      expect(inAddress.status, `${label}: in the address`).toBe(201);
      const inForm = await w
        .api()
        .post('/media')
        .set(own)
        .attach('file', w.picture, 'smuggled.png')
        .field('siteId', shop.ids.siteId)
        .field('site_id', shop.ids.siteId);
      expect([201, 400], `${label}: in a form`).toContain(inForm.status);
      for (const [table, res] of [
        ['content', inAddress],
        ['media', inForm],
      ] as const) {
        if (res.status !== 201) continue;
        const [row] = await w.dataSource.query<{ site: string }[]>(
          `SELECT site_id::text AS site FROM "${table}" WHERE id = $1`,
          [res.body.id],
        );
        expect(row.site, `${label}: whose ${table} row it is`).toBe(w.A.siteId);
      }

      // 5. What the person's own profile says: the first website only, and the organization it is in.
      const me = await call('get', '/auth/me', bearer(who.token));
      expect(me.status).toBe(200);
      expect(
        me.body.memberships.map((one: { site: { id: string } }) => one.site.id),
        label,
      ).toEqual([w.A.siteId]);
      expect(me.body.organizations, label).toEqual([
        {
          id: w.A.organizationId,
          name: 'Acorn Bakery Ltd',
          ownsOrganization: false,
        },
      ]);
      expect(leaks(me), `${label}: the profile`).toBeNull();
    }

    // The other website is byte for byte what it was, in every table that has a site_id.
    expect(await fingerprint(w.dataSource, shop.ids.siteId)).toEqual(
      fingerprintBefore,
    );
  });
});
