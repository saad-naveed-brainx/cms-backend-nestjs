import { BadRequestException, Injectable } from '@nestjs/common';
import type { Media } from '../database/entities/index.js';
import { MediaRepository } from './media.repository.js';
import { MediaStorage } from './media-storage.js';

/** A picture as the admin sees it: where to load it and its small copy, and what it is. */
export type MediaView = {
  id: string;
  filename: string;
  url: string;
  thumbUrl: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  createdAt: Date;
};

/** What the upload route is given for the file (multer's fields that are used). */
export type UploadedPicture = { originalname: string; buffer: Buffer };

/** The name as uploaded, without any folder part, at most 255 characters. */
const tidyName = (name: string): string =>
  (name.split(/[\\/]/).pop() ?? '').trim().slice(0, 255) || 'picture';

/**
 * The media library (MED-01/02, D-042): upload a picture to the site, and list the site's
 * pictures newest first. The files live on the API's disk (`MediaStorage`).
 */
@Injectable()
export class MediaService {
  constructor(
    private readonly media: MediaRepository,
    private readonly storage: MediaStorage,
  ) {}

  async list(
    siteId: string,
    page: { limit: number; offset: number },
  ): Promise<{ items: MediaView[]; total: number }> {
    const { rows, total } = await this.media.list(siteId, page);
    return { items: rows.map((row) => this.view(row)), total };
  }

  async upload(
    siteId: string,
    userId: string,
    file: UploadedPicture | undefined,
  ): Promise<MediaView> {
    if (!file) {
      throw new BadRequestException(
        'Choose a picture to upload (sent as the form field "file")',
      );
    }
    const stored = await this.storage.store(siteId, file.buffer);
    if (stored === 'not-a-picture') {
      throw new BadRequestException(
        'This file is not a picture that can be used: upload a JPEG, PNG or WebP of at most 50 megapixels',
      );
    }
    try {
      const row = await this.media.create(siteId, {
        filename: tidyName(file.originalname),
        storageKey: stored.storageKey,
        mimeType: stored.mimeType,
        sizeBytes: stored.sizeBytes,
        width: stored.width,
        height: stored.height,
        variants: { thumb: stored.thumbKey },
        uploadedBy: userId,
      });
      return this.view(row);
    } catch (error) {
      await this.storage.remove(stored.storageKey, stored.thumbKey);
      throw error;
    }
  }

  private view(row: Media): MediaView {
    return {
      id: row.id,
      filename: row.filename,
      url: this.storage.urlOf(row.storageKey),
      thumbUrl: this.storage.urlOf(row.variants.thumb ?? row.storageKey),
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      width: row.width,
      height: row.height,
      createdAt: row.createdAt,
    };
  }
}
