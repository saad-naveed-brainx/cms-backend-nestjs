import { Module } from '@nestjs/common';
import { PlatformRepository } from './platform.repository.js';

/**
 * The platform desk, for lookups made before any site is known: web address to site, email to
 * user. Import it only where a request has no site yet. Whatever a site owns goes through that
 * site's scoped desk instead.
 */
@Module({
  providers: [PlatformRepository],
  exports: [PlatformRepository],
})
export class PlatformModule {}
