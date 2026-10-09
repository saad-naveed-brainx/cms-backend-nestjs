import { Module } from '@nestjs/common';
import { HostnamesModule } from '../hostnames/hostnames.module.js';
import { WebsiteCache } from './website-cache.service.js';

/** What the API tells the public website (CNT-08): today, to forget a site's cached pages. */
@Module({
  imports: [HostnamesModule],
  providers: [WebsiteCache],
  exports: [WebsiteCache],
})
export class WebsiteModule {}
