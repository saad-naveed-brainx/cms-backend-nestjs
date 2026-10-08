import { Module } from '@nestjs/common';
import { HostnamesModule } from '../hostnames/hostnames.module.js';
import { PlatformModule } from '../platform/platform.module.js';
import { SiteResolver } from './site-resolver.service.js';
import { SitesController } from './sites.controller.js';

/**
 * Host to site: `GET /sites/resolve` and the cached `SiteResolver`. Import this module wherever
 * code changes a site's addresses, name, theme or settings, to call `invalidateSite`.
 */
@Module({
  imports: [PlatformModule, HostnamesModule],
  controllers: [SitesController],
  providers: [SiteResolver],
  exports: [SiteResolver],
})
export class SitesModule {}
