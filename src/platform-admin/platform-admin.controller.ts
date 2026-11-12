import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
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

  /** Suspends an organisation: its websites are unavailable to visitors and read-only to members. 200, or 404. */
  @Post('organizations/:id/suspend')
  @HttpCode(200)
  async suspend(@Param('id') id: string) {
    return this.found(await this.platformAdmin.setSuspended(id, true));
  }

  /** Brings a suspended organisation back, with nothing lost. 200, or 404. */
  @Post('organizations/:id/reactivate')
  @HttpCode(200)
  async reactivate(@Param('id') id: string) {
    return this.found(await this.platformAdmin.setSuspended(id, false));
  }

  /**
   * Changes an organisation's owner (`{ ownerEmail, ownerName?, removeOld? }`). 200 with the new owner, or
   * with a one-time `ownerInvitation.token` when the email has no account yet (the owner stays until it
   * is used). 404 for an organisation that does not exist.
   */
  @Post('organizations/:id/owner')
  @HttpCode(200)
  async changeOwner(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    try {
      return this.found(
        await this.platformAdmin.changeOwner(user.id, id, body),
      );
    } catch (error) {
      throw toHttpError(error);
    }
  }

  /**
   * Deletes an organisation for good: `{ confirmName }` must be its exact name (400 otherwise, nothing
   * deleted). 204, or 404.
   */
  @Delete('organizations/:id')
  @HttpCode(204)
  async remove(@Param('id') id: string, @Body() body: unknown) {
    try {
      const outcome = await this.platformAdmin.deleteOrganization(id, body);
      if (outcome === 'not-found')
        throw new NotFoundException('Organization not found');
    } catch (error) {
      throw toHttpError(error);
    }
  }

  /** The same 404 for an id that does not exist and one that is not an id. */
  private found<T>(result: T | null): T {
    if (!result) throw new NotFoundException('Organization not found');
    return result;
  }
}
