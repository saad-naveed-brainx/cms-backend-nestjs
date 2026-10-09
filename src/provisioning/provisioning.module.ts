import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { PlatformModule } from '../platform/platform.module.js';
import { SitesModule } from '../sites/sites.module.js';
import { ProvisioningRepository } from './provisioning.repository.js';
import { ProvisioningService } from './provisioning.service.js';
import { SiteCreationController } from './site-creation.controller.js';

/**
 * Creating a tenant (FND-06) and adding a site to one (GOV-08a): the service the seed command and
 * the `POST /sites` route call, and the provisioning desk behind it. Import it only where a tenant
 * or a site is created; whatever a site owns afterwards goes through
 * that site's scoped desks.
 */
@Module({
  imports: [PlatformModule, AuthModule, SitesModule],
  controllers: [SiteCreationController],
  providers: [ProvisioningService, ProvisioningRepository],
  exports: [ProvisioningService, ProvisioningRepository],
})
export class ProvisioningModule {}
