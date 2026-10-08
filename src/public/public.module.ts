import { Module } from '@nestjs/common';
import { ContentTypesModule } from '../content-types/content-types.module.js';
import { ContentModule } from '../content/content.module.js';
import { SitesModule } from '../sites/sites.module.js';
import { PublicSiteController } from './public-site.controller.js';
import { PublicSiteService } from './public-site.service.js';

/** What the public website reads (CNT-07): a site's published pages, found by address. */
@Module({
  imports: [SitesModule, ContentModule, ContentTypesModule],
  controllers: [PublicSiteController],
  providers: [PublicSiteService],
})
export class PublicModule {}
