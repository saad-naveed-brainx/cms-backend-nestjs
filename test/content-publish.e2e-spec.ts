import {
  buildContentWorld,
  type ContentWorld,
} from './support/content-world.js';

/**
 * Publishing and unpublishing (CNT-03) through the real routes: real clients, real sign-ins, a real
 * token and `X-Site-Id` on every call. Nothing is mocked.
 */

// Making the clients hashes with production-cost scrypt (about 0.2 s each).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const UNKNOWN_ID = '0198f2a0-0000-7000-8000-000000000999';

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

const act = (
  action: 'publish' | 'unpublish',
  who: { headers: Record<string, string> },
  id: string,
) => world.api().post(`/content/${id}/${action}`).set(who.headers);

const stored = async (id: string) =>
  (
    await world.dataSource.query(
      'SELECT status, published_at, updated_by, title FROM content WHERE id = $1',
      [id],
    )
  )[0];

describe('publish and unpublish', () => {
  it('[UC-RS-01] a person with content.publish publishes a draft, and it is listed as published', async () => {
    const { orchard, newPage, api } = world;
    const page = await newPage(orchard.admin, 'about');

    const res = await act('publish', orchard.publisher, page.id).expect(200);
    expect(res.body).toMatchObject({
      id: page.id,
      status: 'published',
      slug: 'about',
      path: '/about',
      title: 'Title about',
      updatedBy: orchard.publisher.userId,
    });
    expect(
      Math.abs(Date.now() - new Date(res.body.publishedAt).getTime()),
    ).toBeLessThan(10_000);

    const listed = await api()
      .get('/content?status=published')
      .set(orchard.admin.headers)
      .expect(200);
    expect(listed.body.items.map((item: { id: string }) => item.id)).toEqual([
      page.id,
    ]);
  });

  it('[UC-RS-02] publishing a published page changes nothing, so the first publish time stays', async () => {
    const { orchard, newPage } = world;
    const page = await newPage(orchard.admin, 'about');
    await act('publish', orchard.publisher, page.id).expect(200);
    const before = await stored(page.id);

    const again = await act('publish', orchard.admin, page.id).expect(200);
    expect(again.body.status).toBe('published');
    expect(await stored(page.id)).toEqual(before);
  });

  it('[UC-RS-03] unpublishing returns a published page to a draft; a draft cannot be unpublished', async () => {
    const { orchard, newPage } = world;
    const page = await newPage(orchard.admin, 'about');

    const draft = await act('unpublish', orchard.publisher, page.id).expect(
      409,
    );
    expect(draft.body.message).toContain('not published');
    expect((await stored(page.id)).status).toBe('draft');

    await act('publish', orchard.publisher, page.id).expect(200);
    const res = await act('unpublish', orchard.publisher, page.id).expect(200);
    expect(res.body).toMatchObject({ status: 'draft', publishedAt: null });
    expect(await stored(page.id)).toMatchObject({
      status: 'draft',
      published_at: null,
    });
  });

  it('[UC-RS-04] only content.publish may publish, and the routes are guarded', async () => {
    const { orchard, maple, newPage, api } = world;
    const draft = await newPage(orchard.admin, 'draft-page');
    const live = await newPage(orchard.admin, 'live-page');
    await act('publish', orchard.publisher, live.id).expect(200);
    const before = [await stored(draft.id), await stored(live.id)];

    // A viewer, an author and an editor hold no publish permission.
    for (const who of [orchard.viewer, orchard.author, orchard.editor]) {
      await act('publish', who, draft.id).expect(403);
      await act('unpublish', who, live.id).expect(403);
    }

    // Guards: no token, a token with no site, a token for a site that is not yours.
    for (const action of ['publish', 'unpublish'] as const) {
      const path = `/content/${draft.id}/${action}`;
      expect((await api().post(path)).status).toBe(401);
      expect(
        (
          await api()
            .post(path)
            .set('Authorization', orchard.admin.headers.Authorization)
        ).status,
      ).toBe(400);
      expect(
        (
          await api()
            .post(path)
            .set({ ...orchard.admin.headers, 'X-Site-Id': maple.siteId })
        ).status,
      ).toBe(403);
    }

    expect([await stored(draft.id), await stored(live.id)]).toEqual(before);
  });

  it("[UC-RS-05] a page that is not there is a 404: unknown, malformed, in the trash, or another site's", async () => {
    const { orchard, maple, newPage, dataSource } = world;
    const page = await newPage(orchard.admin, 'about');
    const trashed = await newPage(orchard.admin, 'gone');
    await dataSource.query(
      'UPDATE content SET deleted_at = now() WHERE id = $1',
      [trashed.id],
    );

    for (const action of ['publish', 'unpublish'] as const) {
      await act(action, orchard.admin, UNKNOWN_ID).expect(404);
      await act(action, orchard.admin, 'not-a-uuid').expect(404);
      await act(action, orchard.admin, trashed.id).expect(404);
      await act(action, maple.admin, page.id).expect(404);
    }
    expect((await stored(page.id)).status).toBe('draft');
    expect((await stored(trashed.id)).status).toBe('draft');
  });
});
