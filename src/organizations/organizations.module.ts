import { Module } from '@nestjs/common';
import { ProvisioningModule } from '../provisioning/provisioning.module.js';
import { OrganizationsController } from './organizations.controller.js';

/** The organisation routes: the ones a person owns, and creating one (organizations T2). */
@Module({
  imports: [ProvisioningModule],
  controllers: [OrganizationsController],
})
export class OrganizationsModule {}
