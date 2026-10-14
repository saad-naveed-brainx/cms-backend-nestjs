import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Media } from '../database/entities/index.js';
import { ScopedRepository } from '../database/scoped.repository.js';

/** The media desk: one site's uploaded pictures (`media`), one site at a time (invariant 1). */
@Injectable()
export class MediaRepository extends ScopedRepository<Media, 'variants'> {
  constructor(dataSource: DataSource) {
    super(dataSource, Media);
  }

  /** One page of the site's pictures, newest first, and how many there are. */
  list(siteId: string, { limit, offset }: { limit: number; offset: number }) {
    return this.findPage(
      siteId,
      {},
      { order: { createdAt: 'DESC', id: 'DESC' }, limit, offset },
    );
  }
}
