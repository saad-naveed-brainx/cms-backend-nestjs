import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import {
  CurrentSite,
  CurrentUser,
  Public,
  RequirePermission,
  SiteScoped,
} from '../../src/auth/decorators.js';
import { Permission } from '../../src/auth/permission.js';

type Who = { id: string };
type Where = {
  siteId: string;
  roleId: string;
  roleName: string;
  permissions: Permission[];
};

/**
 * Test-only routes for the auth guards (FND-05). The API has no content endpoint to protect yet, so
 * this controller carries one route per way the decorators combine, and `createTestApp([ProbeController])`
 * registers it next to the real ones. It lives under `test/` on purpose: nothing here ships.
 *
 * The routes answer `{ ok: true }` unless a test needs to see what the handler was handed.
 */
@Controller('probe')
export class ProbeController {
  /** No decorator at all: the token guard must close it. */
  @Get('undecorated')
  undecorated() {
    return { ok: true };
  }

  @Public()
  @Get('public')
  open() {
    return { ok: true };
  }

  /** Any member of the named site. */
  @SiteScoped()
  @Get('site')
  site() {
    return { ok: true };
  }

  @RequirePermission(Permission.ContentPublish)
  @Get('publish')
  publish() {
    return { ok: true };
  }

  /** Needs both permissions: holding one of the two is not enough. */
  @RequirePermission(Permission.ContentPublish, Permission.SettingsManage)
  @Get('publish-and-settings')
  publishAndSettings() {
    return { ok: true };
  }

  /** Needs `members.manage`, which the first admin of a seeded tenant must hold (FND-06, UC-TS-02). */
  @RequirePermission(Permission.MembersManage)
  @Get('members')
  members() {
    return { ok: true };
  }

  /** Shows who the handler thinks is calling, and for which site. */
  @RequirePermission(Permission.ContentPublish)
  @Get('whoami')
  whoami(@CurrentUser() user: Who, @CurrentSite() site: Where) {
    return { user, site };
  }

  /** Also hands back the body and query string, to show they reached the handler and were ignored. */
  @RequirePermission(Permission.ContentPublish)
  @HttpCode(200)
  @Post('echo')
  echo(
    @CurrentUser() user: Who,
    @CurrentSite() site: Where,
    @Body() body: unknown,
    @Query() query: unknown,
  ) {
    return { user, site, body, query };
  }
}
