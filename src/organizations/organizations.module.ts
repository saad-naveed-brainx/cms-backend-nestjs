import { Module } from '@nestjs/common';
import { MembersModule } from '../members/members.module.js';
import { PlatformModule } from '../platform/platform.module.js';
import { ProvisioningModule } from '../provisioning/provisioning.module.js';
import { OrganizationTeamService } from './organization-team.service.js';
import { OrganizationsController } from './organizations.controller.js';

/**
 * The organisation routes: the ones a person owns, creating one (organizations T2) and reading its
 * company team (T3).
 */
@Module({
  imports: [ProvisioningModule, PlatformModule, MembersModule],
  controllers: [OrganizationsController],
  providers: [OrganizationTeamService],
})
export class OrganizationsModule {}
