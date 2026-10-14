import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import {
  buildContentWorld,
  type ContentWorld,
  type Who,
} from './support/content-world.js';

/**
 * The media library (MED-01/02, D-042) through the real routes: real sign-ins, real pictures made
 * with sharp, real files on disk (in the tests' own folder, `MEDIA_DIR`), real Postgres.
 */

// Making the clients hashes with production-cost scrypt (about 0.2 s each).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const MEDIA_DIR = process.env.MEDIA_DIR!;
const PUBLIC = 'http://media.test/uploads';

let world: ContentWorld;

beforeAll(async () => {
  world = await buildContentWorld();
});

beforeEach(async () => {
  await world.dataSource.query('DELETE FROM media');
});

afterAll(async () => {
  await world.close();
});

/** A plain picture of the given size and kind. */
const picture = (
  width: number,
  height: number,
  format: 'jpeg' | 'png' | 'webp' = 'png',
) =>
  sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 200, g: 120, b: 40 },
    },
  })
    .toFormat(format)
    .toBuffer();

const upload = (who: Who, bytes: Buffer, filename = 'photo.png') =>
  world.api().post('/media').set(who.headers).attach('file', bytes, filename);

/** The stored file's path on the API's site address, from its public url. */
const served = (url: string) => url.replace(PUBLIC, '/uploads');

const filesOf = (siteId: string): string[] =>
  existsSync(join(MEDIA_DIR, siteId))
    ? readdirSync(join(MEDIA_DIR, siteId))
    : [];

describe('uploading a picture', () => {
  it('[UC-MD-01] a JPEG, PNG or WebP is stored the right way up, scaled to 2400 pixels at most, without what the camera wrote in it, with a small copy, and served from its address', async () => {
    const { orchard, api } = world;

    // A phone photo: 3000 × 1200, stored sideways with an "turn it 90°" note and the camera's details.
    const photo = await sharp({
      create: { width: 3000, height: 1200, channels: 3, background: '#336699' },
    })
      .jpeg()
      .withMetadata({
        orientation: 6,
        exif: { IFD0: { Copyright: 'Secret camera owner', Make: 'PhoneCo' } },
      })
      .toBuffer();
    const res = await upload(
      orchard.admin,
      photo,
      'folder/Team photo.jpg',
    ).expect(201);
    expect(res.body).toMatchObject({
      filename: 'Team photo.jpg',
      mimeType: 'image/jpeg',
      // Turned upright (1200 × 3000), then scaled to fit 2400.
      width: 960,
      height: 2400,
    });
    expect(res.body.url).toMatch(
      new RegExp(`^${PUBLIC}/${orchard.siteId}/[0-9a-f-]{36}\\.jpg$`),
    );
    expect(res.body.thumbUrl).toBe(res.body.url.replace('.jpg', '-thumb.webp'));

    const file = await api().get(served(res.body.url)).buffer(true).expect(200);
    expect(file.headers['content-type']).toBe('image/jpeg');
    expect(file.headers['cache-control']).toMatch(/immutable/);
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    const stored = await sharp(file.body).metadata();
    expect([stored.width, stored.height]).toEqual([960, 2400]);
    expect(stored.exif).toBeUndefined();
    expect(stored.orientation).toBeUndefined();
    expect(res.body.sizeBytes).toBe(file.body.length);

    const thumb = await api()
      .get(served(res.body.thumbUrl))
      .buffer(true)
      .expect(200);
    expect(thumb.headers['content-type']).toBe('image/webp');
    const small = await sharp(thumb.body).metadata();
    expect(Math.max(small.width!, small.height!)).toBe(480);

    // A small PNG and a WebP are kept at their size, in their own kind.
    const png = await upload(orchard.admin, await picture(300, 200)).expect(
      201,
    );
    expect(png.body).toMatchObject({
      mimeType: 'image/png',
      width: 300,
      height: 200,
    });
    expect(png.body.url).toMatch(/\.png$/);
    const webp = await upload(
      orchard.admin,
      await picture(64, 64, 'webp'),
      'a.webp',
    ).expect(201);
    expect(webp.body).toMatchObject({
      mimeType: 'image/webp',
      width: 64,
      height: 64,
    });

    // Who uploaded it is recorded.
    const [row] = await world.dataSource.query(
      'SELECT uploaded_by, site_id FROM media WHERE id = $1',
      [res.body.id],
    );
    expect(row).toEqual({
      uploaded_by: orchard.admin.userId,
      site_id: orchard.siteId,
    });
  });

  it('[UC-MD-02] something that is not an accepted picture, a file over 10 MB, no file, or a person without media.upload is refused, and nothing is stored', async () => {
    const { orchard, api, dataSource } = world;
    const before = filesOf(orchard.siteId).length;

    const notPicture = await upload(
      orchard.admin,
      Buffer.from('just some text, not a picture'),
      'sneaky.jpg',
    ).expect(400);
    expect(notPicture.body.message).toMatch(/upload a JPEG, PNG or WebP/);
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>',
    );
    await upload(orchard.admin, svg, 'logo.svg').expect(400);
    const gif = await sharp({
      create: { width: 4, height: 4, channels: 3, background: '#000' },
    })
      .gif()
      .toBuffer();
    await upload(orchard.admin, gif, 'a.gif').expect(400);

    await upload(
      orchard.admin,
      Buffer.alloc(10 * 1024 * 1024 + 1),
      'huge.png',
    ).expect(413);
    const none = await api()
      .post('/media')
      .set(orchard.admin.headers)
      .expect(400);
    expect(none.body.message).toMatch(/Choose a picture/);

    // Permission is checked before the file is read.
    await upload(orchard.viewer, await picture(10, 10)).expect(403);
    await api()
      .post('/media')
      .attach('file', await picture(10, 10), 'a.png')
      .expect(401);

    expect(await dataSource.query('SELECT 1 FROM media')).toEqual([]);
    expect(filesOf(orchard.siteId)).toHaveLength(before);
  });
});

describe('the library', () => {
  it('[UC-MD-03] lists the site’s own pictures newest first, a page at a time, for any member; another site’s are never in it', async () => {
    const { orchard, maple, api } = world;
    const first = (
      await upload(orchard.admin, await picture(20, 20), 'first.png')
    ).body;
    const second = (
      await upload(orchard.admin, await picture(30, 30), 'second.png')
    ).body;
    const third = (
      await upload(orchard.admin, await picture(40, 40), 'third.png')
    ).body;
    await upload(maple.admin, await picture(50, 50), 'maple.png').expect(201);

    const all = await api()
      .get('/media')
      .set(orchard.viewer.headers)
      .expect(200);
    expect(all.body.total).toBe(3);
    expect(
      all.body.items.map((item: { filename: string }) => item.filename),
    ).toEqual(['third.png', 'second.png', 'first.png']);
    expect(all.body.items[0]).toEqual({
      id: third.id,
      filename: 'third.png',
      url: third.url,
      thumbUrl: third.thumbUrl,
      mimeType: 'image/png',
      sizeBytes: third.sizeBytes,
      width: 40,
      height: 40,
      createdAt: third.createdAt,
    });

    const page = await api()
      .get('/media?limit=1&offset=1')
      .set(orchard.admin.headers)
      .expect(200);
    expect(page.body).toMatchObject({ total: 3, items: [{ id: second.id }] });
    await api().get('/media?limit=0').set(orchard.admin.headers).expect(400);

    const mapleList = await api()
      .get('/media')
      .set(maple.admin.headers)
      .expect(200);
    expect(
      mapleList.body.items.map((item: { filename: string }) => item.filename),
    ).toEqual(['maple.png']);
    expect(first.id).toBeTruthy();
  });

  it('[UC-MD-03] only files the API wrote are served, from inside a site’s folder', async () => {
    const { orchard, api } = world;
    const made = (await upload(orchard.admin, await picture(20, 20))).body;
    const name = made.url.split('/').pop();

    await api().get(`/uploads/${orchard.siteId}/${name}`).expect(200);
    for (const path of [
      `/uploads/${orchard.siteId}/nope.png`,
      `/uploads/${orchard.siteId}/0198f2a0-0000-7000-8000-00000000dead.png`,
      `/uploads/not-a-site/${name}`,
      `/uploads/${orchard.siteId}/..%2F..%2Fpackage.json`,
      `/uploads/${orchard.siteId}/.env`,
    ]) {
      await api().get(path).expect(404);
    }
  });
});

describe('deleting a site', () => {
  it('[UC-MD-04] removes its pictures’ files from the disk too', async () => {
    const { orchard, api } = world;
    const signedIn = { Authorization: orchard.admin.headers.Authorization };
    const made = await api()
      .post('/sites')
      .set(signedIn)
      .send({ name: 'Picture Shop', hostnames: ['pictures.test'] })
      .expect(201);
    const siteId = made.body.site.id as string;
    await upload(
      {
        ...orchard.admin,
        headers: { ...orchard.admin.headers, 'X-Site-Id': siteId },
      },
      await picture(20, 20),
    ).expect(201);
    expect(filesOf(siteId)).toHaveLength(2);

    await api().delete(`/sites/${siteId}`).set(signedIn).expect(204);
    expect(existsSync(join(MEDIA_DIR, siteId))).toBe(false);
    // The other site's pictures are untouched.
    expect(existsSync(MEDIA_DIR)).toBe(true);
  });
});
