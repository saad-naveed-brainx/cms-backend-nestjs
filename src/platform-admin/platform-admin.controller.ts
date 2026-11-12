import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { CurrentUser, type AuthUser } from '../auth/decorators.js';
import { toHttpError } from '../provisioning/http-errors.js';
import { PlatformAdminGuard } from './platform-admin.guard.js';
import { PlatformAdminService } from './platform-admin.service.js';

/**
 * The platform routes (platform-admin, D-062): only a super admin, checked on every request. They
 * need a sign-in and no `X-Site-Id`: they are about organisations, never about one website, and
 * nothing here reaches what a website owns.
 */
@Controller('platform')
@UseGuards(PlatformAdminGuard)
export class PlatformAdminController {
  constructor(private readonly platformAdmin: PlatformAdminService) {}

  /** Every organisation: name, owner (or who it waits for), website count and status. */
  @Get('organizations')
  async organizations() {
    return { items: await this.platformAdmin.listOrganizations() };
  }

  /**
   * Makes an organisation for an owner (`{ name, ownerEmail, ownerName? }`). 201 with the owner, or
   * with a one-time `ownerInvitation.token` when the email has no account yet: shown once.
   */
  @Post('organizations')
  async createOrganization(
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    try {
      return await this.platformAdmin.createOrganization(user.id, body);
    } catch (error) {
      throw toHttpError(error);
    }
  }
}
