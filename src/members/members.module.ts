import { Module } from '@nestjs/common';
import { SiteMemberRepository } from './site-member.repository.js';

/** The members desk. Import this module to ask what a user may do on a site; nothing else reaches the table. */
@Module({
  providers: [SiteMemberRepository],
  exports: [SiteMemberRepository],
})
export class MembersModule {}
