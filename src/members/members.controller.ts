import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
} from '@nestjs/common';
import { z } from 'zod';
import {
  CurrentSite,
  RequirePermission,
  type SiteAccess,
} from '../auth/decorators.js';
import { Permission } from '../auth/permission.js';
import { parseOr400 } from '../content/content-input.js';
import { MembersService } from './members.service.js';

const changeRoleBody = z.strictObject({ roleId: z.uuid() });

/**
 * The people of the site named by `X-Site-Id` (users-roles T2). Every route needs
 * `members.manage` (Administrators).
 */
@Controller('members')
export class MembersController {
  constructor(private readonly members: MembersService) {}

  @Get()
  @RequirePermission(Permission.MembersManage)
  list(@CurrentSite() site: SiteAccess) {
    return this.members.list(site.siteId);
  }

  @Patch(':userId')
  @RequirePermission(Permission.MembersManage)
  changeRole(
    @CurrentSite() site: SiteAccess,
    @Param('userId') userId: string,
    @Body() body: unknown,
  ) {
    const { roleId } = parseOr400(changeRoleBody, body);
    return this.members.changeRole(site.siteId, userId, roleId);
  }

  @Delete(':userId')
  @HttpCode(204)
  @RequirePermission(Permission.MembersManage)
  async remove(
    @CurrentSite() site: SiteAccess,
    @Param('userId') userId: string,
  ): Promise<void> {
    await this.members.remove(site.siteId, userId);
  }
}
