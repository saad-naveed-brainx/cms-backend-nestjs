import { Module } from '@nestjs/common';
import { MembersController } from './members.controller.js';
import { MembersService } from './members.service.js';
import { SiteMemberRepository } from './site-member.repository.js';

/**
 * The members desk and the people routes (`GET /members`, `PATCH` and `DELETE /members/:userId`).
 * Import this module to ask what a user may do on a site; nothing else reaches the table.
 */
@Module({
  controllers: [MembersController],
  providers: [SiteMemberRepository, MembersService],
  exports: [SiteMemberRepository],
})
export class MembersModule {}
