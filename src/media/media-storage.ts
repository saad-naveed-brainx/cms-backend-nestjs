import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import sharp, { type OutputInfo } from 'sharp';
import { v7 as uuidv7 } from 'uuid';
import { isUuid } from '../database/scoped.repository.js';

/** The kinds of picture accepted, by what the file really is (not by its name or the browser's word). */
const ACCEPTED = {
  jpeg: { ext: 'jpg', mime: 'image/jpeg' },
  png: { ext: 'png', mime: 'image/png' },
  webp: { ext: 'webp', mime: 'image/webp' },
} as const;
type Format = keyof typeof ACCEPTED;

/** The stored picture is at most this wide and tall; a larger one is scaled down. */
const MAIN_SIZE = 2400;
/** The library's small copy. */
const THUMB_SIZE = 480;
/** A file this small can still claim to be enormous once opened: refuse beyond 50 megapixels. */
const MAX_PIXELS = 50_000_000;

/** A stored file's name: `<uuid>.jpg` or `<uuid>-thumb.webp`. */
export const STORED_NAME = /^[0-9a-f-]{36}(?:-thumb)?\.(?:jpg|png|webp)$/;

export const CONTENT_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

export type StoredPicture = {
  storageKey: string;
  thumbKey: string;
  mimeType: string;
  sizeBytes: number;
  width: number;
  height: number;
};

/**
 * Uploaded pictures on the API's own disk (MED-01, D-042): `<MEDIA_DIR>/<site id>/<uuid>.<ext>`
 * and a `-thumb.webp` beside it. Each upload is read with sharp, turned the right way up, scaled
 * down to 2400 pixels at most and written again, which also drops what the camera put in the file
 * (location, device). Their public address is `MEDIA_PUBLIC_URL` plus the key.
 */
@Injectable()
export class MediaStorage {
  readonly root: string;
  private readonly publicUrl: string;

  constructor(config: ConfigService) {
    this.root = resolve(config.get<string>('MEDIA_DIR') || 'uploads');
    const port =
      config.get<string>('API_PORT') ?? config.get<string>('PORT') ?? '4000';
    this.publicUrl = (
      config.get<string>('MEDIA_PUBLIC_URL') ||
      `http://localhost:${port}/uploads`
    ).replace(/\/+$/, '');
  }

  /** The address a browser loads a stored file from. */
  urlOf(key: string): string {
    return `${this.publicUrl}/${key}`;
  }

  /** Stores the picture for the site, or says it is not one this accepts. */
  async store(
    siteId: string,
    bytes: Buffer,
  ): Promise<StoredPicture | 'not-a-picture'> {
    if (!isUuid(siteId)) throw new Error('A stored picture needs its site id');
    const open = () => sharp(bytes, { limitInputPixels: MAX_PIXELS }).rotate();

    let format: Format;
    try {
      const found = (
        await sharp(bytes, { limitInputPixels: MAX_PIXELS }).metadata()
      ).format;
      if (!Object.hasOwn(ACCEPTED, found)) return 'not-a-picture';
      format = found as Format;
    } catch {
      return 'not-a-picture';
    }

    let main: { data: Buffer; info: OutputInfo };
    let thumb: Buffer;
    try {
      main = await open()
        .resize(MAIN_SIZE, MAIN_SIZE, {
          fit: 'inside',
          withoutEnlargement: true,
        })
        .toFormat(format)
        .toBuffer({ resolveWithObject: true });
      thumb = await open()
        .resize(THUMB_SIZE, THUMB_SIZE, {
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp({ quality: 80 })
        .toBuffer();
    } catch {
      return 'not-a-picture';
    }

    const name = uuidv7();
    const { ext, mime } = ACCEPTED[format];
    const storageKey = `${siteId}/${name}.${ext}`;
    const thumbKey = `${siteId}/${name}-thumb.webp`;
    await mkdir(join(this.root, siteId), { recursive: true });
    await writeFile(join(this.root, storageKey), main.data);
    await writeFile(join(this.root, thumbKey), thumb);
    return {
      storageKey,
      thumbKey,
      mimeType: mime,
      sizeBytes: main.data.length,
      width: main.info.width,
      height: main.info.height,
    };
  }

  /** Removes stored files (after a failed save). Missing ones are fine. */
  async remove(...keys: string[]): Promise<void> {
    await Promise.all(
      keys.map((key) => rm(join(this.root, key), { force: true })),
    );
  }

  /** Removes every picture of a deleted site (D-039). */
  async removeSite(siteId: string): Promise<void> {
    if (!isUuid(siteId)) return;
    await rm(join(this.root, siteId), { recursive: true, force: true });
  }
}
