import { Module } from '@nestjs/common';
import { SitesModule } from '../sites/sites.module.js';
import { WebsiteModule } from '../website/website.module.js';
import { AppearanceController } from './appearance.controller.js';
import { AppearanceService } from './appearance.service.js';
import { SiteRepository } from './site.repository.js';

/** A site's name, header tagline, footer note and theme (GOV-04): `GET` and `PATCH /appearance`. */
@Module({
  imports: [SitesModule, WebsiteModule],
  controllers: [AppearanceController],
  providers: [SiteRepository, AppearanceService],
})
export class AppearanceModule {}
