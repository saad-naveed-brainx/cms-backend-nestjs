import { Module } from '@nestjs/common';
import { InvitationRepository } from '../invitations/invitation.repository.js';
import { MembersController } from './members.controller.js';
import { MembersService } from './members.service.js';
import { SiteMemberRepository } from './site-member.repository.js';

/**
 * The members desk and the people routes (`GET /members`, `PATCH` and `DELETE /members/:userId`).
 * Import this module to ask what a user may do on a site; nothing else reaches the table. It also
 * provides the scoped invitations desk, since `GET /members` lists the waiting invitations
 * (`InvitationsModule` uses it from here, which keeps the modules free of a cycle with `AuthModule`).
 */
@Module({
  controllers: [MembersController],
  providers: [SiteMemberRepository, InvitationRepository, MembersService],
  exports: [SiteMemberRepository, InvitationRepository],
})
export class MembersModule {}
