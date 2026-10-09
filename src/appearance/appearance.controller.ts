import { Body, Controller, Get, Patch } from '@nestjs/common';
import {
  CurrentSite,
  RequirePermission,
  SiteScoped,
  type SiteAccess,
} from '../auth/decorators.js';
import { Permission } from '../auth/permission.js';
import { parseOr400 } from '../content/content-input.js';
import { appearanceBody } from './appearance-input.js';
import { AppearanceService } from './appearance.service.js';

/**
 * The appearance of the site named by `X-Site-Id` (GOV-04): every member may read it; saving needs
 * `settings.manage`.
 */
@Controller('appearance')
export class AppearanceController {
  constructor(private readonly appearance: AppearanceService) {}

  @Get()
  @SiteScoped()
  get(@CurrentSite() site: SiteAccess) {
    return this.appearance.get(site.siteId);
  }

  @Patch()
  @RequirePermission(Permission.SettingsManage)
  update(@CurrentSite() site: SiteAccess, @Body() body: unknown) {
    return this.appearance.update(
      site.siteId,
      parseOr400(appearanceBody, body),
    );
  }
}
