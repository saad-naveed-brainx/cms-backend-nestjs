import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { PlatformModule } from '../platform/platform.module.js';
import { ProvisioningRepository } from './provisioning.repository.js';
import { ProvisioningService } from './provisioning.service.js';

/**
 * Creating a tenant (FND-06): the service the seed command calls, and the provisioning desk behind
 * it. Import it only where a whole tenant is created; whatever a site owns afterwards goes through
 * that site's scoped desks.
 */
@Module({
  imports: [PlatformModule, AuthModule],
  providers: [ProvisioningService, ProvisioningRepository],
  exports: [ProvisioningService, ProvisioningRepository],
})
export class ProvisioningModule {}
