import { PreviewTokenService } from '../src/preview/preview-token.service.js';
import {
  buildContentWorld,
  type ContentWorld,
} from './support/content-world.js';

/**
 * Preview links (feature site-preview, D-029), through the real routes: a member asks for a link
 * to a page with the content route, and the website opens it with the public route, no sign-in.
 * Two real clients made by the real provisioning service; nothing mocked.
 */

// Making the clients hashes with production-cost scrypt (about 0.2 s each).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const HERO = { type: 'hero', headline: 'Not ready yet' };

let world: ContentWorld;

beforeAll(async () => {
  world = await buildContentWorld();
});

beforeEach(async () => {
  await world.dataSource.query('DELETE FROM content');
});

afterAll(async () => {
  await world.close();
});

/** What the admin does: ask for a link to a page. */
const askForLink = (headers: Record<string, string>, id: string) =>
  world.api().post(`/content/${id}/preview`).set(headers);

/** What the website does: open a link at an address, with no sign-in. */
const openLink = (host: string | undefined, token: string | undefined) => {
  const query = new URLSearchParams();
  if (host !== undefined) query.set('host', host);
  if (token !== undefined) query.set('token', token);
  return world.api().get(`/public/preview?${query}`);
};

describe('a preview link', () => {
  it('[UC-SP-07] shows a draft as last saved, at its own site, never indexed or stored by a cache, while the public site still hides it', async () => {
    const { admin } = world.orchard;
    const page = await world.newPage(admin, 'plans', { blocks: [HERO] });

    const link = await askForLink(admin.headers, page.id).expect(200);
    expect(Object.keys(link.body).sort()).toEqual(['expiresAt', 'token']);
    const minutesLeft = (Date.parse(link.body.expiresAt) - Date.now()) / 60_000;
    expect(minutesLeft).toBeGreaterThan(29);
    expect(minutesLeft).toBeLessThanOrEqual(30);

    const opened = await openLink('orchard.test', link.body.token).expect(200);
    expect(opened.headers['cache-control']).toBe('no-store');
    expect(opened.body.page).toMatchObject({
      title: 'Title plans',
      path: '/plans',
      noIndex: true,
      blocks: [HERO],
    });
    expect(opened.body.preview).toEqual({ status: 'draft' });
    expect(opened.body.site.name).toBe('Orchard Bakery');
    // Nothing internal leaves: no ids.
    expect(JSON.stringify(opened.body)).not.toContain(page.id);
    expect(JSON.stringify(opened.body)).not.toContain(world.orchard.siteId);

    // A later save shows in the same link: it names the page, not a copy of it.
    await world
      .api()
      .patch(`/content/${page.id}`)
      .set(admin.headers)
      .send({ title: 'Plans, second go' })
      .expect(200);
    const again = await openLink('orchard.test', link.body.token).expect(200);
    expect(again.body.page.title).toBe('Plans, second go');

    // The draft is still not public.
    await world
      .api()
      .get('/public/site?host=orchard.test&path=/plans')
      .expect(404);
  });

  it('[UC-SP-08] any member may ask for one; nobody else may, and only for a page of their site', async () => {
    const { admin, viewer } = world.orchard;
    const page = await world.newPage(admin, 'plans');

    await askForLink(viewer.headers, page.id).expect(200);
    await askForLink({}, page.id).expect(401);
    await askForLink(
      { ...world.maple.admin.headers, 'X-Site-Id': world.orchard.siteId },
      page.id,
    ).expect(403);
    // Maple's admin, on Maple, asking for Orchard's page.
    await askForLink(world.maple.admin.headers, page.id).expect(404);
    await askForLink(
      admin.headers,
      '0198f2a0-0000-7000-8000-0000000009ff',
    ).expect(404);
  });

  it('[UC-SP-09] a link that is out of date, tampered with, missing, or a sign-in token is refused, and a link is no sign-in', async () => {
    const { admin } = world.orchard;
    const page = await world.newPage(admin, 'plans');
    const previews = world.app.get(PreviewTokenService);

    // Made 31 minutes ago, so it ran out a minute ago.
    const old = await previews.sign(
      world.orchard.siteId,
      page.id,
      Date.now() - 31 * 60_000,
    );
    await openLink('orchard.test', old.token).expect(401);

    const { body } = await askForLink(admin.headers, page.id).expect(200);
    const [head, claims, signature] = (body.token as string).split('.');
    const flipped = `${head}.${claims}.${signature.slice(0, -2)}${signature.endsWith('AA') ? 'BB' : 'AA'}`;
    await openLink('orchard.test', flipped).expect(401);
    await openLink('orchard.test', undefined).expect(401);
    await openLink('orchard.test', 'not-a-token').expect(401);

    // The admin's own sign-in token does not open a preview...
    const signInToken = admin.headers.Authorization.replace('Bearer ', '');
    await openLink('orchard.test', signInToken).expect(401);
    // ...and a preview link does not sign anyone in.
    await world
      .api()
      .get('/auth/me')
      .set('Authorization', `Bearer ${body.token}`)
      .expect(401);
  });

  it('[UC-SP-10] a good link at another address, or for a page since trashed, is not found', async () => {
    const { admin } = world.orchard;
    const page = await world.newPage(admin, 'plans');
    const { body } = await askForLink(admin.headers, page.id).expect(200);

    await openLink('maple.test', body.token).expect(404);
    await openLink('nobody.test', body.token).expect(404);
    await openLink('not a host', body.token).expect(400);

    await world.dataSource.query(
      'UPDATE content SET deleted_at = now() WHERE id = $1',
      [page.id],
    );
    await openLink('orchard.test', body.token).expect(404);
  });
});
