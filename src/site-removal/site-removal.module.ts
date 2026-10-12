import { Module } from '@nestjs/common';
import { SitesModule } from '../sites/sites.module.js';
import { WebsiteModule } from '../website/website.module.js';
import { SiteRemovalController } from './site-removal.controller.js';
import { SiteRemovalRepository } from './site-removal.repository.js';
import { SiteRemovalService } from './site-removal.service.js';

/** Deleting a site (D-039): the route, and the one desk allowed to delete a site's row. */
@Module({
  imports: [SitesModule, WebsiteModule],
  controllers: [SiteRemovalController],
  providers: [SiteRemovalService, SiteRemovalRepository],
})
export class SiteRemovalModule {}
