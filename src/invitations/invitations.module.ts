import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { MembersModule } from '../members/members.module.js';
import { InvitationAcceptanceRepository } from './invitation-acceptance.repository.js';
import { InvitationsController } from './invitations.controller.js';
import { InvitationsService } from './invitations.service.js';

/**
 * Invitation routes (users-roles T3). The scoped `InvitationRepository` is provided by
 * `MembersModule`, because `GET /members` lists waiting invitations too; the unscoped acceptance
 * desk is only here.
 */
@Module({
  imports: [AuthModule, MembersModule],
  controllers: [InvitationsController],
  providers: [InvitationsService, InvitationAcceptanceRepository],
  exports: [InvitationsService],
})
export class InvitationsModule {}
