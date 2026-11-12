import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { PlatformModule } from '../platform/platform.module.js';
import { PlatformAdminController } from './platform-admin.controller.js';
import { PlatformAdminGuard } from './platform-admin.guard.js';
import { PlatformAdminRepository } from './platform-admin.repository.js';
import { PlatformAdminService } from './platform-admin.service.js';

/**
 * The platform operator (platform-admin, D-062): the command that makes a super admin now, and the
 * routes that create and run organisations in the next tickets. Its desk is the third one allowed to
 * read across organisations.
 */
@Module({
  imports: [PlatformModule, AuthModule],
  controllers: [PlatformAdminController],
  providers: [
    PlatformAdminService,
    PlatformAdminRepository,
    PlatformAdminGuard,
  ],
  exports: [PlatformAdminService, PlatformAdminRepository, PlatformAdminGuard],
})
export class PlatformAdminModule {}
