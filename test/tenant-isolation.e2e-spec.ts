import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { MetadataScanner, ModulesContainer, Reflector } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  IS_PUBLIC,
  REQUIRED_PERMISSIONS,
  SITE_SCOPED,
} from '../src/auth/decorators.js';
import { Permission } from '../src/auth/permission.js';
import { invite } from './support/invitations.js';
import { addMember } from './support/members.js';
import { seedVersion } from './support/seed.js';
import {
  buildWorld,
  fingerprint,
  ownedIds,
  tenantTables,
  type Side,
  type World,
} from './support/two-clients.js';

/**
 * Tenant isolation (FND-03, and the cross-tenant hunt of GOV-08b): a person who belongs to one
 * client can never read or change another client's data, through any door. Two clients, Acorn and
 * Birch, made through the real routes, share what a leak could hide behind (the same page address,
 * the same type address, one person in both); every door of the API is listed in a table that is
 * checked against what the running app really declares; and each client in turn attacks the other.
 * Real people, real tokens, real routes, the real database. Nothing is mocked.
 */

// Making the clients hashes passwords with production-cost scrypt (about 0.2 s each).
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

// ---------------------------------------------------------------------------------------------
// The doors
// ---------------------------------------------------------------------------------------------

/** The ids and names a request can be aimed at: one side's, or ones that exist nowhere. */
type Target = Pick<
  Side,
  | 'siteId'
  | 'organizationId'
  | 'aboutId'
  | 'draftId'
  | 'memberId'
  | 'roleId'
  | 'invitationId'
  | 'versionId'
  | 'mediaName'
>;

type Call = {
  method: 'get' | 'post' | 'patch' | 'delete';
  path: string;
  json?: Record<string, unknown>;
  /** Multipart: attaches a small picture as the `file` field, with these other fields. */
  upload?: boolean;
  fields?: Record<string, string>;
};

/**
 * `open`: no token. `person`: a token, no site. `site`: a token and `X-Site-Id`, with these
 * permissions (some routes check who may in the service instead, so their list is empty).
 */
type Kind = 'open' | 'person' | 'site';

type Probe = {
  /** `METHOD /path` exactly as the app declares it. */
  key: string;
  kind: Kind;
  permissions?: Permission[];
  /** A valid request aimed at the things of `t`. Open routes have none: groups 3 and 4 test them. */
  call?: (t: Target) => Call;
  /** The request names one of `t`'s ids, so another site's id can be put in it. */
  ids?: boolean;
  /** Running it for real deletes or changes what it is given, so it needs ids of its own. */
  disposable?: boolean;
  /** A create: the table its row lands in, whose column says whose it is, and where its id is in the answer. */
  creates?: {
    table: string;
    owner: 'site_id' | 'organization_id' | 'owner_id';
    idOf: (body: any) => string;
  };
};

let serial = 0;
const uniq = () => `t${(serial += 1)}`;

const get = (path: string): Call => ({ method: 'get', path });
const post = (path: string, json?: Record<string, unknown>): Call => ({
  method: 'post',
  path,
  json,
});
const patch = (path: string, json: Record<string, unknown>): Call => ({
  method: 'patch',
  path,
  json,
});
const del = (path: string): Call => ({ method: 'delete', path });

/**
 * Every route the API has, and what each one is. Checked against the running app (UC-TI-01): a
 * route missing here, gone, or marked differently in the code fails the test by name. A new route
 * is added here on purpose, with a request that the sweeps can aim at another client.
 */
const ROUTES: Probe[] = [
  { key: 'GET /', kind: 'open' },
  { key: 'GET /health', kind: 'open' },
  { key: 'POST /auth/login', kind: 'open' },
  { key: 'GET /auth/me', kind: 'person', call: () => get('/auth/me') },

  { key: 'GET /appearance', kind: 'site', call: () => get('/appearance') },
  {
    key: 'PATCH /appearance',
    kind: 'site',
    permissions: [Permission.SettingsManage],
    call: () => patch('/appearance', { tagline: 'Changed by an attack' }),
  },

  {
    key: 'GET /content-types',
    kind: 'site',
    call: () => get('/content-types'),
  },
  {
    key: 'POST /content-types',
    kind: 'site',
    permissions: [Permission.ContentTypesManage],
    call: () =>
      post('/content-types', {
        name: `Type ${uniq()}`,
        urlPrefix: `/${uniq()}`,
      }),
    creates: { table: 'content_types', owner: 'site_id', idOf: (b) => b.id },
  },

  { key: 'GET /content', kind: 'site', call: () => get('/content') },
  {
    key: 'GET /content/:id',
    kind: 'site',
    ids: true,
    call: (t) => get(`/content/${t.aboutId}`),
  },
  {
    key: 'POST /content',
    kind: 'site',
    permissions: [Permission.ContentCreate],
    call: () =>
      post('/content', { type: 'page', title: 'Created', slug: uniq() }),
    creates: { table: 'content', owner: 'site_id', idOf: (b) => b.id },
  },
  {
    key: 'PATCH /content/:id',
    kind: 'site',
    ids: true,
    disposable: true,
    call: (t) =>
      patch(`/content/${t.aboutId}`, { title: 'Changed by an attack' }),
  },
  {
    // Versions of a page (version-history T1): whoever may edit the page reads them.
    key: 'GET /content/:id/versions',
    kind: 'site',
    ids: true,
    call: (t) => get(`/content/${t.aboutId}/versions`),
  },
  {
    key: 'GET /content/:id/versions/:versionId',
    kind: 'site',
    ids: true,
    call: (t) => get(`/content/${t.aboutId}/versions/${t.versionId}`),
  },
  {
    key: 'POST /content/:id/preview',
    kind: 'site',
    ids: true,
    call: (t) => post(`/content/${t.draftId}/preview`),
  },
  {
    key: 'POST /content/:id/publish',
    kind: 'site',
    ids: true,
    disposable: true,
    call: (t) => post(`/content/${t.draftId}/publish`),
  },
  {
    key: 'POST /content/:id/unpublish',
    kind: 'site',
    ids: true,
    disposable: true,
    call: (t) => post(`/content/${t.aboutId}/unpublish`),
  },

  {
    key: 'POST /invitations',
    kind: 'site',
    permissions: [Permission.MembersManage],
    ids: true,
    call: (t) =>
      post('/invitations', {
        email: `${uniq()}@invited.test`,
        roleId: t.roleId,
      }),
    creates: {
      table: 'invitations',
      owner: 'site_id',
      idOf: (b) => b.invitation.id,
    },
  },
  { key: 'POST /invitations/lookup', kind: 'open' },
  { key: 'POST /invitations/accept', kind: 'open' },
  {
    key: 'POST /invitations/:id/renew',
    kind: 'site',
    permissions: [Permission.MembersManage],
    ids: true,
    disposable: true,
    call: (t) => post(`/invitations/${t.invitationId}/renew`),
  },
  {
    key: 'DELETE /invitations/:id',
    kind: 'site',
    permissions: [Permission.MembersManage],
    ids: true,
    disposable: true,
    call: (t) => del(`/invitations/${t.invitationId}`),
  },

  { key: 'GET /media', kind: 'site', call: () => get('/media') },
  {
    key: 'POST /media',
    kind: 'site',
    permissions: [Permission.MediaUpload],
    call: () => ({ method: 'post', path: '/media', upload: true }),
    creates: { table: 'media', owner: 'site_id', idOf: (b) => b.id },
  },
  { key: 'GET /uploads/:siteId/:name', kind: 'open' },

  {
    key: 'GET /members',
    kind: 'site',
    permissions: [Permission.MembersManage],
    call: () => get('/members'),
  },
  {
    key: 'PATCH /members/:userId',
    kind: 'site',
    permissions: [Permission.MembersManage],
    ids: true,
    disposable: true,
    call: (t) => patch(`/members/${t.memberId}`, { roleId: t.roleId }),
  },
  {
    key: 'DELETE /members/:userId',
    kind: 'site',
    permissions: [Permission.MembersManage],
    ids: true,
    disposable: true,
    call: (t) => del(`/members/${t.memberId}`),
  },

  {
    key: 'GET /organizations',
    kind: 'person',
    call: () => get('/organizations'),
  },
  {
    // Whoever is signed in may make one and owns it (organizations T2, D-056).
    key: 'POST /organizations',
    kind: 'person',
    call: () => post('/organizations', { name: `Organization ${uniq()}` }),
    creates: {
      table: 'organizations',
      owner: 'owner_id',
      idOf: (b) => b.id,
    },
  },
  {
    // Only the organization's owner reads its team (organizations T3, D-054); anyone else is told
    // what is told of an organization that is not there.
    key: 'GET /organizations/:id/team',
    kind: 'person',
    ids: true,
    call: (t) => get(`/organizations/${t.organizationId}/team`),
  },
  {
    key: 'POST /sites',
    kind: 'person',
    ids: true,
    call: (t) =>
      post('/sites', {
        name: `Site ${uniq()}`,
        hostnames: [`${uniq()}.test`],
        organizationId: t.organizationId,
      }),
    creates: {
      table: 'sites',
      owner: 'organization_id',
      idOf: (b) => b.site.id,
    },
  },
  {
    key: 'DELETE /sites/:id',
    kind: 'person',
    ids: true,
    disposable: true,
    call: (t) => del(`/sites/${t.siteId}`),
  },
  { key: 'GET /sites/resolve', kind: 'open' },

  { key: 'GET /public/site', kind: 'open' },
  { key: 'GET /public/preview', kind: 'open' },
];

const closed = ROUTES.filter((probe) => probe.kind !== 'open');
const siteRoutes = ROUTES.filter((probe) => probe.kind === 'site');
const idRoutes = closed.filter((probe) => probe.ids);
const writes = closed.filter(
  (probe) => probe.call && probe.call(nowhere()).method !== 'get',
);

/** Ids and names that exist nowhere, for what an answer about "a thing that is not there" looks like. */
function nowhere(): Target {
  return {
    siteId: randomUUID(),
    organizationId: randomUUID(),
    aboutId: randomUUID(),
    draftId: randomUUID(),
    memberId: randomUUID(),
    roleId: randomUUID(),
    invitationId: randomUUID(),
    versionId: randomUUID(),
    mediaName: `${randomUUID()}.png`,
  };
}

// ---------------------------------------------------------------------------------------------
// The world, and how to send into it
// ---------------------------------------------------------------------------------------------

let w: World;
/** Every id of Acorn's and of Birch's, for finding them in an answer meant for the other side. */
let idsOf: Record<string, string[]>;

type Res = { status: number; body: any; text: string };
type Headers = Record<string, string | string[]>;

beforeAll(async () => {
  w = await buildWorld();
  const owned = async (side: Side) =>
    [...(await ownedIds(w.dataSource, side.siteId)), side.mediaName].filter(
      (id) => id !== w.pat.userId,
    );
  idsOf = { acorn: await owned(w.A), birch: await owned(w.B) };
});

afterAll(async () => {
  await w.close();
});

/** What an attacker of `attacker` is: their token, and the site header they choose. */
const asSide = (attacker: Side, siteHeader: string | string[]): Headers => ({
  Authorization: `Bearer ${attacker.owner.token}`,
  'X-Site-Id': siteHeader,
});

async function send(call: Call, headers: Headers): Promise<Res> {
  let request = w.api()[call.method](call.path);
  for (const [name, value] of Object.entries(headers))
    request = request.set(name, value as string);
  if (call.upload) {
    request = request.attach('file', w.picture, 'upload.png');
    for (const [name, value] of Object.entries(call.fields ?? {}))
      request = request.field(name, value);
  } else if (call.json !== undefined) {
    request = request.send(call.json);
  }
  const res = await request;
  return { status: res.status, body: res.body, text: res.text ?? '' };
}

/** What an answer says about the other side, if anything: its name in any text, or one of its ids that the request did not supply. */
function leakIn(res: Res, victim: Side, sent: unknown): string | null {
  if (new RegExp(victim.tag, 'i').test(res.text))
    return `it mentions ${victim.tag}`;
  const supplied = JSON.stringify(sent);
  const found = idsOf[victim.tag].find(
    (id) => res.text.includes(id) && !supplied.includes(id),
  );
  return found ? `it contains ${found}, an id of ${victim.tag}'s` : null;
}

/** Two answers, as far as a stranger could tell them apart: the status and the message. */
const look = (res: Res) =>
  `${res.status} ${JSON.stringify(res.body?.message ?? null)}`;

const unchanged = async (side: Side, before: Record<string, string>) =>
  expect(await fingerprint(w.dataSource, side.siteId)).toEqual(before);

/** Ids of one's own that running a destructive request for real may use up. */
async function disposable(side: Side): Promise<Target> {
  const h = side.owner.headers;
  const page = async (publish: boolean) => {
    const made = await w
      .api()
      .post('/content')
      .set(h)
      .send({ type: 'page', title: 'Spare', slug: uniq() });
    if (made.status !== 201) throw new Error(`disposable page: ${made.status}`);
    if (publish)
      await w.api().post(`/content/${made.body.id}/publish`).set(h).expect(200);
    return made.body.id as string;
  };
  const member = await addMember(w.app, side.siteId, {
    email: `${uniq()}@${side.tag}.test`,
    name: 'Spare Person',
    role: 'Author',
  });
  const invited = await invite(
    w.app,
    side.owner,
    `${uniq()}@invited.test`,
    'Author',
  );
  const spare = await w
    .api()
    .post('/sites')
    .set({ Authorization: h.Authorization })
    // The organization is named: once a sweep has made the owner another one (`POST /organizations`),
    // a site made without it is a 400, because the owner then owns several.
    .send({
      name: `Spare ${uniq()}`,
      hostnames: [`${uniq()}.test`],
      organizationId: side.organizationId,
    })
    .expect(201);
  const draftId = await page(false);
  const aboutId = await page(true);
  // A version of the spare page, so the request that reads one is a valid request (the pages desk
  // writes a version of its own on a save, T2; this one is written straight, as the world's are).
  const version = await seedVersion(w.dataSource, {
    siteId: side.siteId,
    contentId: aboutId,
    createdBy: side.owner.userId,
  });
  return {
    siteId: spare.body.site.id,
    organizationId: side.organizationId,
    draftId,
    aboutId,
    memberId: member.userId,
    roleId: side.roleId,
    invitationId: invited.id,
    versionId: version.id,
    mediaName: side.mediaName,
  };
}

const PAIRS = () => [
  { attacker: w.A, victim: w.B },
  { attacker: w.B, victim: w.A },
];

// ---------------------------------------------------------------------------------------------
// 1. Every door is known
// ---------------------------------------------------------------------------------------------

describe('every door is known', () => {
  it('[UC-TI-01] every route the app has is in the table, with the kind the code declares, and no route in the table is gone', () => {
    const reflector = w.app.get(Reflector);
    const scanner = new MetadataScanner();
    const found = new Map<string, { kind: Kind; permissions: string[] }>();

    for (const module of w.app.get(ModulesContainer).values()) {
      for (const wrapper of module.controllers.values()) {
        const { instance, metatype } = wrapper;
        if (!instance || !metatype) continue;
        const prototype = Object.getPrototypeOf(instance);
        const bases = ([] as string[]).concat(
          reflector.get<string | string[]>(PATH_METADATA, metatype) ?? '',
        );
        for (const name of scanner.getAllMethodNames(prototype)) {
          const handler = prototype[name];
          const method = reflector.get<number | undefined>(
            METHOD_METADATA,
            handler,
          );
          if (method === undefined) continue; // a helper, not a route
          const paths = ([] as string[]).concat(
            reflector.get<string | string[]>(PATH_METADATA, handler) ?? '',
          );
          const targets = [handler, metatype];
          const isPublic = reflector.getAllAndOverride<boolean | undefined>(
            IS_PUBLIC,
            targets,
          );
          const siteScoped = reflector.getAllAndOverride<boolean | undefined>(
            SITE_SCOPED,
            targets,
          );
          const permissions =
            reflector.getAllAndOverride<string[] | undefined>(
              REQUIRED_PERMISSIONS,
              targets,
            ) ?? [];
          const kind: Kind = isPublic ? 'open' : siteScoped ? 'site' : 'person';
          for (const base of bases) {
            // The super admin's routes (`/platform/...`) are checked by
            // `test/platform-admin-*.e2e-spec.ts`; platform-admin T6 brings them into this table.
            if (base === 'platform') continue;
            for (const path of paths) {
              const joined =
                '/' +
                [base, path]
                  .map((part) => part.replace(/^\/+|\/+$/g, ''))
                  .filter(Boolean)
                  .join('/');
              found.set(`${RequestMethod[method]} ${joined}`, {
                kind,
                permissions: [...permissions].sort(),
              });
            }
          }
        }
      }
    }

    // Reading nothing would make every comparison below trivially fine. The table has 34 routes today:
    // 25 is the floor that keeps a scan that silently finds (almost) nothing from passing.
    expect(found.size).toBeGreaterThan(25);

    const table = new Map(ROUTES.map((probe) => [probe.key, probe]));
    const missing = [...found.keys()].filter((key) => !table.has(key)).sort();
    const gone = [...table.keys()].filter((key) => !found.has(key)).sort();
    const different = ROUTES.filter((probe) => found.has(probe.key))
      .filter((probe) => {
        const live = found.get(probe.key)!;
        return (
          live.kind !== probe.kind ||
          live.permissions.join() !==
            [...(probe.permissions ?? [])].sort().join()
        );
      })
      .map((probe) => {
        const live = found.get(probe.key)!;
        return `${probe.key}: the code says ${live.kind} [${live.permissions}], the table says ${probe.kind} [${probe.permissions ?? []}]`;
      });

    // A route in "missing" is new: add it to ROUTES, with a request the sweeps can aim at the other side.
    expect({ missing, gone, different }).toEqual({
      missing: [],
      gone: [],
      different: [],
    });
  });

  it('[UC-TI-02] every closed door is closed: no token is a 401, and a site route with a token and no site is a 400', async () => {
    const problems: string[] = [];
    for (const probe of closed) {
      const call = probe.call!(w.A);
      const stranger = await send(call, {});
      if (stranger.status !== 401)
        problems.push(`${probe.key} with no token: ${stranger.status}`);
      const forged = await send(call, { Authorization: 'Bearer not-a-token' });
      if (forged.status !== 401)
        problems.push(`${probe.key} with a bad token: ${forged.status}`);
      if (probe.kind === 'site') {
        const noSite = await send(call, {
          Authorization: `Bearer ${w.A.owner.token}`,
        });
        if (noSite.status !== 400)
          problems.push(
            `${probe.key} with a token and no X-Site-Id: ${noSite.status}`,
          );
      }
    }
    expect(problems).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// 2. One client against another
// ---------------------------------------------------------------------------------------------

/** UC-TI-03: the other side's site header, as it is and in every spelling a person might try. */
async function attackWithTheirHeader(
  attacker: Side,
  victim: Side,
): Promise<string[]> {
  const problems: string[] = [];
  const spellings: [string, string | string[], number][] = [
    ['in capitals', victim.siteId.toUpperCase(), 403],
    ['with a letter too many', `${victim.siteId}a`, 400],
    ['next to their own', [attacker.siteId, victim.siteId], 400],
    ['not an id', 'not-a-uuid', 400],
    ['empty', '', 400],
  ];
  for (const probe of siteRoutes) {
    const call = probe.call!(victim);
    const headers = asSide(attacker, victim.siteId);
    const res = await send(call, headers);
    if (res.status !== 403)
      problems.push(`${probe.key}: expected 403, got ${res.status}`);
    const leak = leakIn(res, victim, { call, headers });
    if (leak) problems.push(`${probe.key}: ${leak}`);

    // Refused exactly as a site that does not exist is, so the answer never says which sites exist.
    const missing = await send(
      probe.call!(nowhere()),
      asSide(attacker, randomUUID()),
    );
    if (look(res) !== look(missing)) {
      problems.push(
        `${probe.key}: another client's site is answered "${look(res)}" but a site that is not there "${look(missing)}"`,
      );
    }

    for (const [what, value, expected] of spellings) {
      const spelled = await send(call, asSide(attacker, value));
      if (spelled.status !== expected)
        problems.push(
          `${probe.key}: the site id ${what}: expected ${expected}, got ${spelled.status}`,
        );
      const found = leakIn(spelled, victim, { call, value });
      if (found) problems.push(`${probe.key}: the site id ${what}: ${found}`);
    }
  }
  return problems;
}

/** UC-TI-04: the attacker's own site header, with the other side's ids in the request. */
async function attackWithTheirIds(
  attacker: Side,
  victim: Side,
): Promise<string[]> {
  const problems: string[] = [];
  for (const probe of idRoutes) {
    const call = probe.call!(victim);
    const headers = asSide(attacker, attacker.siteId);
    const res = await send(call, headers);
    const absent = await send(probe.call!(nowhere()), headers);
    if (res.status < 400)
      problems.push(
        `${probe.key}: another client's id was accepted (${res.status})`,
      );
    if (look(res) !== look(absent)) {
      problems.push(
        `${probe.key}: another client's id is answered "${look(res)}" but an id that is not there "${look(absent)}"`,
      );
    }
    const leak = leakIn(res, victim, { call, headers });
    if (leak) problems.push(`${probe.key}: ${leak}`);
  }
  return problems;
}

/** UC-TI-06: a create or an edit with the other side's site id smuggled into the body, the form or the address. */
async function smuggleWrites(attacker: Side, victim: Side): Promise<string[]> {
  const problems: string[] = [];
  const extra = { siteId: victim.siteId, site_id: victim.siteId };
  for (const probe of writes) {
    for (const how of ['the body', 'the address'] as const) {
      const target = probe.disposable ? await disposable(attacker) : attacker;
      let call = probe.call!(target);
      if (how === 'the address')
        call = {
          ...call,
          path: `${call.path}?siteId=${victim.siteId}&site_id=${victim.siteId}`,
        };
      else if (call.upload) call = { ...call, fields: extra };
      else call = { ...call, json: { ...call.json, ...extra } };

      const res = await send(call, asSide(attacker, attacker.siteId));
      const label = `${probe.key} with it in ${how}`;
      if (res.status !== 400 && (res.status < 200 || res.status > 299)) {
        problems.push(
          `${label}: expected a refusal (400) or a normal answer, got ${res.status}`,
        );
        continue;
      }
      const leak = leakIn(res, victim, { call });
      if (leak) problems.push(`${label}: ${leak}`);

      // Whatever was made belongs to the attacker's own side.
      if (probe.creates && res.status >= 200 && res.status < 300) {
        const { table, owner, idOf } = probe.creates;
        const column = owner;
        const rows = await w.dataSource.query<{ owner: string }[]>(
          `SELECT ${column}::text AS owner FROM "${table}" WHERE id = $1`,
          [idOf(res.body)],
        );
        const expected =
          owner === 'site_id'
            ? attacker.siteId
            : owner === 'owner_id'
              ? attacker.owner.userId
              : attacker.organizationId;
        if (rows.length !== 1 || rows[0].owner !== expected) {
          problems.push(
            `${label}: what was made is not the attacker's own (${JSON.stringify(rows)})`,
          );
        }
      }
    }
  }
  return problems;
}

describe('one client against another', () => {
  it("[UC-TI-03] the other client's site header does not work: 403 on every site route, in every spelling, answered as a site that is not there, and nothing changes", async () => {
    for (const { attacker, victim } of PAIRS()) {
      const before = await fingerprint(w.dataSource, victim.siteId);
      expect(
        await attackWithTheirHeader(attacker, victim),
        `${attacker.tag} against ${victim.tag}`,
      ).toEqual([]);
      await unchanged(victim, before);
    }
  });

  it("[UC-TI-04] the other client's ids do not work under one's own header: an error on every route that takes an id, answered as an id that is not there, and nothing changes", async () => {
    for (const { attacker, victim } of PAIRS()) {
      const before = await fingerprint(w.dataSource, victim.siteId);
      expect(
        await attackWithTheirIds(attacker, victim),
        `${attacker.tag} against ${victim.tag}`,
      ).toEqual([]);
      await unchanged(victim, before);
    }
  });

  it("[UC-TI-04] the same requests succeed on one's own things, so the refusals are about whose things they are and not about a bad request", async () => {
    const problems: string[] = [];
    for (const probe of idRoutes) {
      const own = await disposable(w.A);
      const res = await send(probe.call!(own), asSide(w.A, w.A.siteId));
      if (res.status < 200 || res.status > 299)
        problems.push(
          `${probe.key} on A's own things: ${res.status} ${JSON.stringify(res.body)}`,
        );
    }
    expect(problems).toEqual([]);
  });

  it('[UC-TI-05] lists and reads show only one’s own: nothing of the other client, though both share page and type addresses, and one person in both sees each site under its own header', async () => {
    for (const { attacker, victim } of PAIRS()) {
      const before = await fingerprint(w.dataSource, victim.siteId);
      const problems: string[] = [];
      const reads = closed.filter(
        (probe) => probe.call && probe.call(attacker).method === 'get',
      );
      for (const probe of reads) {
        const headers = asSide(attacker, attacker.siteId);
        const res = await send(probe.call!(attacker), headers);
        if (res.status !== 200) problems.push(`${probe.key}: ${res.status}`);
        const leak = leakIn(res, victim, { headers });
        if (leak) problems.push(`${probe.key}: ${leak}`);
      }
      expect(problems, `${attacker.tag} reading`).toEqual([]);

      // The shared address and the shared type appear once, and are the reader's own.
      const mine = asSide(attacker, attacker.siteId);
      const pages = (await send(get('/content?path=/about'), mine)).body.items;
      expect(pages.map((p: any) => p.title)).toEqual([
        `${attacker.tag === 'acorn' ? 'Acorn' : 'Birch'} About`,
      ]);
      const types = (await send(get('/content-types'), mine)).body.items.filter(
        (t: any) => t.slug === 'recipe',
      );
      expect(types).toHaveLength(1);
      expect(types[0].id).toBe(attacker.typeId);
      const members = (await send(get('/members'), mine)).body.members.map(
        (m: any) => m.userId,
      );
      expect(members).toEqual(
        expect.arrayContaining([
          attacker.owner.userId,
          attacker.memberId,
          w.pat.userId,
        ]),
      );
      expect(members).not.toContain(victim.owner.userId);
      expect(members).not.toContain(victim.memberId);
      await unchanged(victim, before);
    }

    // One person in both sites: each header shows that site and nothing of the other.
    const titlesAtAbout = async (headers: Headers) =>
      (await send(get('/content?path=/about'), headers)).body.items.map(
        (page: any) => page.title,
      );
    expect(await titlesAtAbout(w.pat.headersA)).toEqual(['Acorn About']);
    expect(await titlesAtAbout(w.pat.headersB)).toEqual(['Birch About']);
    expect((await send(get('/content'), w.pat.headersA)).text).not.toMatch(
      /birch/i,
    );
    expect((await send(get('/content'), w.pat.headersB)).text).not.toMatch(
      /acorn/i,
    );
    // Their role differs per site, and so does what they may do.
    expect(
      (
        await send(
          post('/content', { type: 'page', title: 'Pat page', slug: uniq() }),
          w.pat.headersA,
        )
      ).status,
    ).toBe(201);
    expect((await send(get('/members'), w.pat.headersA)).status).toBe(403);
    expect((await send(get('/members'), w.pat.headersB)).status).toBe(403);
  });

  it("[UC-TI-06] a create or an edit lands in one's own site: a smuggled site id in the body, the form or the address is refused or ignored, and nothing is added to the other client", async () => {
    for (const { attacker, victim } of PAIRS()) {
      const before = await fingerprint(w.dataSource, victim.siteId);
      expect(
        await smuggleWrites(attacker, victim),
        `${attacker.tag} against ${victim.tag}`,
      ).toEqual([]);
      await unchanged(victim, before);
    }
  });

  it('[UC-TI-07] the other client is byte for byte what it was, in every table that has a site_id, found from the database itself', async () => {
    // The fingerprint reads every tenant table, including ones nobody remembered.
    const tables = await tenantTables(w.dataSource);
    for (const expected of [
      'content',
      'content_types',
      'hostnames',
      'invitations',
      'media',
      'roles',
      'site_members',
    ]) {
      expect(tables).toContain(expected);
    }
    const fingerprintOfB = await fingerprint(w.dataSource, w.B.siteId);
    for (const table of [
      'content',
      'content_types',
      'hostnames',
      'invitations',
      'media',
      'roles',
      'site_members',
    ]) {
      expect(
        fingerprintOfB[table],
        `${table} should hold rows of B's, or the check proves nothing`,
      ).not.toMatch(/^0 rows/);
    }

    // The fingerprint really notices: a change to one row of B's shows, and putting it back does too.
    const before = await fingerprint(w.dataSource, w.B.siteId);
    await w.dataSource.query(
      `UPDATE content SET title = title || '!' WHERE id = $1`,
      [w.B.aboutId],
    );
    expect(await fingerprint(w.dataSource, w.B.siteId)).not.toEqual(before);
    await w.dataSource.query(
      `UPDATE content SET title = replace(title, '!', '') WHERE id = $1`,
      [w.B.aboutId],
    );
    expect(await fingerprint(w.dataSource, w.B.siteId)).toEqual(before);

    // Everything above at once, each side against the other: the victim is exactly what it was.
    for (const { attacker, victim } of PAIRS()) {
      const was = await fingerprint(w.dataSource, victim.siteId);
      const problems = [
        ...(await attackWithTheirHeader(attacker, victim)),
        ...(await attackWithTheirIds(attacker, victim)),
        ...(await smuggleWrites(attacker, victim)),
      ];
      expect(problems, `${attacker.tag} against ${victim.tag}`).toEqual([]);
      await unchanged(victim, was);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 3. Public doors and links
// ---------------------------------------------------------------------------------------------

/**
 * A GET with the path exactly as written. supertest tidies a `..` away before sending (so a "climbing"
 * path would quietly become an honest one), whereas this reaches the server untouched.
 */
function rawGet(
  path: string,
): Promise<{ status: number; contentType: string }> {
  const { port } = w.app.getHttpServer().address() as AddressInfo;
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path }, (res) => {
        res.resume();
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            contentType: String(res.headers['content-type'] ?? ''),
          }),
        );
      })
      .on('error', reject);
  });
}

const publicSite = (host: string, path = '/about') =>
  w.api().get('/public/site').query({ host, path });
const titleOf = (side: Side) => (side.tag === 'acorn' ? 'Acorn' : 'Birch');

describe('public doors and links', () => {
  /** An address in every spelling a person might try, with the other client's mixed in. */
  const spellings = (own: string, other: string) => [
    own,
    own.toUpperCase(),
    `${own}.`,
    `${own}:8080`,
    ` ${own}`,
    `${own} `,
    `${own}\u0000`,
    `${own},${other}`,
    `${other},${own}`,
    `${own}@${other}`,
    `${other}@${own}`,
    `${own}.${other}`,
    `${other}.${own}`,
    `x${own}`,
    `${own}x`,
    `${own}/${other}`,
    '*.test',
    'test',
  ];

  it("[UC-TI-08] addresses do not cross: every spelling of one client's address answers that client's page or an error, never the other's, and the same path on both addresses gives each its own", async () => {
    const problems: string[] = [];
    for (const [mine, theirs] of [
      [w.A, w.B],
      [w.B, w.A],
    ]) {
      for (const host of spellings(mine.host, theirs.host)) {
        const label = `${mine.tag} as ${JSON.stringify(host)}`;
        const res = await publicSite(host);
        if (res.status === 200) {
          if (res.body.page?.title !== `${titleOf(mine)} About`) {
            problems.push(
              `${label}: answered with ${JSON.stringify(res.body.page?.title)}`,
            );
          }
        } else if (res.status !== 400 && res.status !== 404) {
          problems.push(`${label}: ${res.status}`);
        }
        if (new RegExp(theirs.tag, 'i').test(res.text))
          problems.push(`${label}: it mentions ${theirs.tag}`);

        const found = await w.api().get('/sites/resolve').query({ host });
        if (found.status === 200 && found.body.site.id !== mine.siteId) {
          problems.push(`${label}: /sites/resolve answered with another site`);
        }
      }
    }
    // Asked for twice, the address is refused, not half-heard.
    const twice = await w
      .api()
      .get('/public/site?host=acorn.test&host=birch.test&path=/about');
    if (twice.status !== 400)
      problems.push(`the address given twice: ${twice.status}`);
    expect(problems).toEqual([]);

    for (const side of [w.A, w.B]) {
      const name = titleOf(side);
      const about = await publicSite(side.host, '/about').expect(200);
      expect(about.body.page.title).toBe(`${name} About`);
      await publicSite(side.host, '/draft').expect(404);
      const soup = await publicSite(side.host, '/recipes/soup').expect(200);
      expect(soup.body.page.title).toBe(`${name} Soup`);
      // A draft item of the type is not public: it is not in the listing, nor at its own address.
      await w
        .api()
        .post('/content')
        .set(side.owner.headers)
        .send({
          type: 'recipe',
          title: `${name} Draft Soup`,
          slug: 'draft-soup',
        })
        .expect(201);
      await publicSite(side.host, '/recipes/draft-soup').expect(404);
      const listing = await publicSite(side.host, '/recipes').expect(200);
      expect(listing.body.kind).toBe('listing');
      expect(
        listing.body.listing.items.map((item: { title: string }) => item.title),
      ).toEqual([`${name} Soup`]);
      const other = side.tag === 'acorn' ? 'birch' : 'acorn';
      for (const res of [about, soup, listing])
        expect(res.text).not.toMatch(new RegExp(other, 'i'));
    }
  });

  it("[UC-TI-09] pictures do not cross: a picture is served under its own client's id only, another client's id, a guessed name and every path-climbing spelling are a 404, and no folder can be listed", async () => {
    const url = (siteId: string, name: string) => `/uploads/${siteId}/${name}`;
    const own = await w.api().get(url(w.A.siteId, w.A.mediaName)).expect(200);
    expect(own.headers['content-type']).toMatch(/image\/png/);
    expect(
      (await w.api().get(url(w.B.siteId, w.B.mediaName)).expect(200)).headers[
        'content-type'
      ],
    ).toMatch(/image\/png/);

    const thumb = (name: string) => name.replace(/\.png$/, '-thumb.webp');
    const refused = [
      url(w.B.siteId, w.A.mediaName), // A's file under B's id
      url(w.A.siteId, w.B.mediaName), // B's file under A's id
      url(w.A.siteId, thumb(w.B.mediaName)),
      url(w.A.siteId, `${randomUUID()}.png`), // a name nobody made
      `/uploads/${w.A.siteId}/..%2F${w.B.siteId}%2F${w.B.mediaName}`,
      `/uploads/${w.A.siteId}/%2e%2e%2f${w.B.siteId}%2f${w.B.mediaName}`,
      `/uploads/${w.A.siteId}%2F..%2F${w.B.siteId}/${w.B.mediaName}`,
      `/uploads/${w.A.siteId}/..%5C${w.B.siteId}%5C${w.B.mediaName}`,
      `/uploads/${w.A.siteId}/${w.B.mediaName}%00.png`,
      `/uploads/${w.A.siteId}/`,
      `/uploads/${w.A.siteId}`,
      '/uploads/',
      '/uploads',
    ];
    const problems: string[] = [];
    for (const path of refused) {
      const res = await w.api().get(path);
      if (res.status !== 404) problems.push(`${path}: ${res.status}`);
      if (res.status === 200 && res.headers['content-type']?.includes('image'))
        problems.push(`${path}: served a picture`);
    }
    // Climbing paths, sent exactly as written.
    for (const path of [
      `/uploads/${w.A.siteId}/../${w.B.siteId}/${w.B.mediaName}`,
      `/uploads/../uploads/${w.B.siteId}/${w.B.mediaName}`,
      `/uploads/${w.A.siteId}/./../${w.B.siteId}/${w.B.mediaName}`,
      `/uploads/${w.A.siteId}//${w.B.mediaName}`,
      `/uploads//${w.B.siteId}/${w.B.mediaName}`,
    ]) {
      const res = await rawGet(path);
      if (res.status !== 404) problems.push(`raw ${path}: ${res.status}`);
      if (res.contentType.includes('image'))
        problems.push(`raw ${path}: served a picture`);
    }
    expect(problems).toEqual([]);
  });

  it('[UC-TI-10] links belong to one client: an invitation adds the person to its own client only (also with a site id smuggled in), a preview link opens its own page only on its own address, and a sign-in token is not a preview link', async () => {
    const beforeB = await fingerprint(w.dataSource, w.B.siteId);

    // An invitation made in A.
    const found = await w
      .api()
      .post('/invitations/lookup')
      .send({ token: w.A.invitationToken })
      .expect(200);
    // It names the site and its organization, by id too (organizations T1), and nothing of B.
    expect(found.body.site).toEqual({ id: w.A.siteId, name: 'Acorn Bakery' });
    expect(found.body.organization).toEqual({
      id: w.A.organizationId,
      name: 'Acorn Bakery Ltd',
    });
    expect(JSON.stringify(found.body)).not.toMatch(/birch/i);
    const joined = await w
      .api()
      .post('/invitations/accept')
      .send({
        token: w.A.invitationToken,
        name: 'Nia Newbie',
        password: 'newbie-password-123',
      })
      .expect(200);
    expect(
      joined.body.memberships.map(
        (m: { site: { name: string } }) => m.site.name,
      ),
    ).toEqual(['Acorn Bakery']);
    const sitesOf = async (email: string) =>
      (
        await w.dataSource.query<{ site_id: string }[]>(
          `SELECT sm.site_id FROM site_members sm JOIN users u ON u.id = sm.user_id WHERE u.email = $1`,
          [email],
        )
      ).map((row) => row.site_id);
    expect(await sitesOf(w.A.invitationEmail)).toEqual([w.A.siteId]);

    // Another one, accepted with the other client's site id slipped into the request.
    const second = await invite(
      w.app,
      w.A.owner,
      'newbie2@acorn.test',
      'Author',
    );
    const sneaky = await w.api().post('/invitations/accept').send({
      token: second.token,
      name: 'Nia Two',
      password: 'newbie-password-123',
      siteId: w.B.siteId,
      site_id: w.B.siteId,
    });
    expect([200, 400]).toContain(sneaky.status);
    expect(await sitesOf('newbie2@acorn.test')).not.toContain(w.B.siteId);
    await unchanged(w.B, beforeB);

    // Preview links: one page, one client, one address.
    const open = (host: string, token: string) =>
      w.api().get('/public/preview').query({ host, token });
    const own = await open(w.B.host, w.B.previewToken);
    expect(own.status).toBe(200);
    expect(own.body.page.title).toBe('Birch Draft');
    for (const [host, token, other] of [
      [w.A.host, w.B.previewToken, 'birch'],
      [w.B.host, w.A.previewToken, 'acorn'],
    ] as const) {
      const res = await open(host, token);
      expect(res.status, `${other}'s link at ${host}`).toBe(404);
      expect(res.text).not.toMatch(new RegExp(other, 'i'));
    }
    expect((await open(w.A.host, w.A.owner.token)).status).toBe(401); // a sign-in token is not a preview link
    const asLogin = await w
      .api()
      .get('/auth/me')
      .set('Authorization', `Bearer ${w.B.previewToken}`);
    expect(asLogin.status).toBe(401); // and a preview link signs nobody in
  });
});

// ---------------------------------------------------------------------------------------------
// 4. The hunt
// ---------------------------------------------------------------------------------------------

describe('the hunt', () => {
  it("[UC-TI-11] another client's page id in odd spellings is never found, never an error of ours, and answered like an id that is not there", async () => {
    const headers = asSide(w.A, w.A.siteId);
    const problems: string[] = [];
    const absent = look(await send(get(`/content/${randomUUID()}`), headers));
    for (const [what, id] of [
      ['upper case', w.B.draftId.toUpperCase()],
      ['with a trailing slash', `${w.B.draftId}/`],
      ['with a space', `${w.B.draftId}%20`],
      ['with a NUL', `${w.B.draftId}%00`],
      ['with SQL in it', `${w.B.draftId}'%20OR%20'1'='1`],
      ['as SQL alone', `'%20OR%20'1'='1`],
      ['with a dot segment', `..%2F${w.B.draftId}`],
      ['doubled', `${w.B.draftId},${w.B.draftId}`],
    ]) {
      for (const call of [
        get(`/content/${id}`),
        post(`/content/${id}/preview`),
        patch(`/content/${id}`, { title: 'x' }),
      ]) {
        const res = await send(call, headers);
        if (res.status >= 500)
          problems.push(`${what} ${call.method} ${call.path}: ${res.status}`);
        if (res.status === 200)
          problems.push(
            `${what} ${call.method} ${call.path}: found something (200)`,
          );
        if (
          look(res) !== absent &&
          res.status !== 400 &&
          !String(res.body?.message).startsWith('Cannot ')
        )
          problems.push(
            `${what} ${call.method}: answered "${look(res)}", not like a missing id "${absent}"`,
          );
        const leak = leakIn(res, w.B, { call });
        if (leak) problems.push(`${what} ${call.method}: ${leak}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("[UC-TI-11] filters and types never reach the other client: a type only Birch has, Birch's type id, and shared addresses all answer from one's own site", async () => {
    // Birch alone gets a type Acorn does not have.
    const menu = await w
      .api()
      .post('/content-types')
      .set(w.B.owner.headers)
      .send({ name: 'Menu', urlPrefix: '/menus' })
      .expect(201);
    await w
      .api()
      .post('/content')
      .set(w.B.owner.headers)
      .send({ type: 'menu', title: 'Birch Lunch', slug: 'lunch' })
      .expect(201);
    const mine = asSide(w.A, w.A.siteId);

    const make = await send(
      post('/content', { type: 'menu', title: 'Acorn tries', slug: 'tries' }),
      mine,
    );
    expect(make.status).toBe(400);
    expect(make.text).not.toMatch(/birch/i);
    const byType = await send(get('/content?type=menu'), mine);
    expect(byType.body.items).toEqual([]);
    const byTypeId = await send(get(`/content?type=${menu.body.id}`), mine);
    expect(byTypeId.body.items ?? []).toEqual([]);
    const byPath = await send(get('/content?path=/recipes/soup'), mine);
    expect(
      byPath.body.items.map((item: { title: string }) => item.title),
    ).toEqual(['Acorn Soup']);
    expect(
      (await send(get('/content-types'), mine)).body.items.map(
        (t: { slug: string }) => t.slug,
      ),
    ).not.toContain('menu');
    expect((await send(get('/content-types'), mine)).text).not.toMatch(
      /birch/i,
    );
  });

  it("[UC-TI-11] a role or a member of the other client mixed into one's own request is refused, and nothing is changed", async () => {
    const before = await fingerprint(w.dataSource, w.B.siteId);
    const mine = asSide(w.A, w.A.siteId);
    // A's own member, B's role.
    const swap = await send(
      patch(`/members/${w.A.memberId}`, { roleId: w.B.roleId }),
      mine,
    );
    expect(swap.status).toBe(400);
    expect(swap.text).not.toMatch(/birch/i);
    // B's member, A's role: not a member of this site.
    const other = await send(
      patch(`/members/${w.B.memberId}`, { roleId: w.A.roleId }),
      mine,
    );
    expect(other.status).toBe(404);
    // An invitation with B's role.
    const invited = await send(
      post('/invitations', { email: 'mix@acorn.test', roleId: w.B.roleId }),
      mine,
    );
    expect(invited.status).toBe(400);
    // A's member is unchanged: still the Author.
    const members = (await send(get('/members'), mine)).body.members;
    expect(
      members.find((m: { userId: string }) => m.userId === w.A.memberId).role
        .name,
    ).toBe('Author');
    await unchanged(w.B, before);
  });

  it('[UC-TI-11] the same email invited to both clients stays two separate invitations, and joining one does not join the other', async () => {
    const a = await invite(w.app, w.A.owner, 'dual@elsewhere.test', 'Editor');
    const b = await invite(w.app, w.B.owner, 'dual@elsewhere.test', 'Viewer');
    const sitesOf = async () =>
      (
        await w.dataSource.query<{ site_id: string; role: string }[]>(
          `SELECT sm.site_id, r.name AS role FROM site_members sm
             JOIN users u ON u.id = sm.user_id JOIN roles r ON r.id = sm.role_id WHERE u.email = 'dual@elsewhere.test'`,
        )
      ).map((row) => `${row.site_id}:${row.role}`);

    await w
      .api()
      .post('/invitations/accept')
      .send({
        token: a.token,
        name: 'Dual Person',
        password: 'dual-password-123',
      })
      .expect(200);
    expect(await sitesOf()).toEqual([`${w.A.siteId}:Editor`]);
    // B's link is still good, and joining with the account they now have adds B with B's role.
    await w
      .api()
      .post('/invitations/lookup')
      .send({ token: b.token })
      .expect(200);
    await w
      .api()
      .post('/invitations/accept')
      .send({ token: b.token, password: 'dual-password-123' })
      .expect(200);
    expect((await sitesOf()).sort()).toEqual(
      [`${w.A.siteId}:Editor`, `${w.B.siteId}:Viewer`].sort(),
    );
  });

  it('[UC-TI-11] taking a person out of one client takes effect at once and leaves their other client alone', async () => {
    const before = await w
      .api()
      .get('/content?path=/about')
      .set(w.pat.headersB)
      .expect(200);
    expect(before.body.items[0].title).toBe('Birch About');

    await w
      .api()
      .delete(`/members/${w.pat.userId}`)
      .set(w.B.owner.headers)
      .expect(204);
    // The same token, now refused for B, still good for A.
    expect(
      (await w.api().get('/content?path=/about').set(w.pat.headersB)).status,
    ).toBe(403);
    const stillA = await w
      .api()
      .get('/content?path=/about')
      .set(w.pat.headersA)
      .expect(200);
    expect(stillA.body.items[0].title).toBe('Acorn About');
  });

  it('[UC-TI-11] deleting one client leaves the other exactly as it was, and what was only the deleted one’s stops answering', async () => {
    const before = await fingerprint(w.dataSource, w.A.siteId);
    await w
      .api()
      .delete(`/sites/${w.B.siteId}`)
      .set({ Authorization: `Bearer ${w.B.owner.token}` })
      .expect(204);

    expect(await fingerprint(w.dataSource, w.A.siteId)).toEqual(before);
    const gone = await fingerprint(w.dataSource, w.B.siteId);
    expect(
      Object.values(gone).every(
        (value) => value === 'gone' || value.startsWith('0 rows'),
      ),
    ).toBe(true);
    await publicSite(w.B.host, '/about').expect(404);
    await w.api().get('/sites/resolve').query({ host: w.B.host }).expect(404);
    await w.api().get(`/uploads/${w.B.siteId}/${w.B.mediaName}`).expect(404);
    await publicSite(w.A.host, '/about').expect(200);
    await w.api().get(`/uploads/${w.A.siteId}/${w.A.mediaName}`).expect(200);
    // The shared person keeps their account and their other client.
    const me = await w
      .api()
      .get('/auth/me')
      .set({ Authorization: w.pat.headersA.Authorization })
      .expect(200);
    expect(
      me.body.memberships.map((m: { site: { name: string } }) => m.site.name),
    ).toEqual(['Acorn Bakery']);
  });
});
