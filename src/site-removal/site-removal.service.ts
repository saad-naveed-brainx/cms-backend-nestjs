import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { isUuid } from '../database/scoped.repository.js';
import { MediaStorage } from '../media/media-storage.js';
import { SiteResolver } from '../sites/site-resolver.service.js';
import { WebsiteCache } from '../website/website-cache.service.js';
import { SiteRemovalRepository } from './site-removal.repository.js';

/**
 * Deleting a site for good (D-039): only the owner of its organisation may, and everything the site
 * owns goes with it, its pictures' files included. Afterwards its addresses stop answering at once: the address lookup forgets the
 * site, and the website is told to forget what it kept for each address.
 */
@Injectable()
export class SiteRemovalService {
  constructor(
    private readonly sites: SiteRemovalRepository,
    private readonly resolver: SiteResolver,
    private readonly website: WebsiteCache,
    private readonly media: MediaStorage,
  ) {}

  /** A malformed id and a site that is not there, or not the person's to see, are the same 404. */
  async remove(userId: string, siteId: unknown): Promise<void> {
    if (!isUuid(siteId)) throw new NotFoundException('Site not found');
    const removal = await this.sites.deleteOwnedSite(siteId, userId);
    if (removal.outcome === 'not-found') {
      throw new NotFoundException('Site not found');
    }
    if (removal.outcome === 'not-owner') {
      throw new ForbiddenException(
        'Only the owner of the organisation can delete this site',
      );
    }
    this.resolver.invalidateSite(siteId);
    await this.website.forgetHosts(removal.hostnames, `deleted site ${siteId}`);
    // Its rows went with the site; its pictures' files are on disk.
    await this.media.removeSite(siteId);
  }
}
