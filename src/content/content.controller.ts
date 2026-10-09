import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  CurrentSite,
  CurrentUser,
  RequirePermission,
  SiteScoped,
  type AuthUser,
  type SiteAccess,
} from '../auth/decorators.js';
import { Permission } from '../auth/permission.js';
import {
  createPageBody,
  listQuery,
  parseOr400,
  updatePageBody,
} from './content-input.js';
import { ContentService } from './content.service.js';

/**
 * Pages of the site named by `X-Site-Id` (CNT-01). Reading is for every member of the site;
 * creating needs `content.create`; editing is decided by the service (`content.edit_any`, or
 * `content.edit_own` on a page the person created); publishing needs `content.publish`. There is
 * no delete or move here: those are CNT-11 and CNT-04/05/06.
 */
@Controller('content')
export class ContentController {
  constructor(private readonly content: ContentService) {}

  @Get()
  @SiteScoped()
  list(@CurrentSite() site: SiteAccess, @Query() query: unknown) {
    return this.content.list(site.siteId, parseOr400(listQuery, query));
  }

  @Get(':id')
  @SiteScoped()
  get(@CurrentSite() site: SiteAccess, @Param('id') id: string) {
    return this.content.get(site.siteId, id);
  }

  @Post()
  @RequirePermission(Permission.ContentCreate)
  create(
    @CurrentSite() site: SiteAccess,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.content.create(site, user, parseOr400(createPageBody, body));
  }

  @Patch(':id')
  @SiteScoped()
  update(
    @CurrentSite() site: SiteAccess,
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.content.update(
      site,
      user,
      id,
      parseOr400(updatePageBody, body),
    );
  }

  /**
   * A 30-minute link that shows this page as last saved, published or not, on the site's own
   * address (`?preview=<token>` on the website). Any member of the site may ask for one.
   */
  @Post(':id/preview')
  @HttpCode(200)
  @SiteScoped()
  preview(@CurrentSite() site: SiteAccess, @Param('id') id: string) {
    return this.content.preview(site.siteId, id);
  }

  /** Makes a page live. Needs `content.publish`, and nothing else. */
  @Post(':id/publish')
  @HttpCode(200)
  @RequirePermission(Permission.ContentPublish)
  publish(
    @CurrentSite() site: SiteAccess,
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ) {
    return this.content.publish(site, user, id);
  }

  /** Takes a published page back to a draft. Needs `content.publish`. */
  @Post(':id/unpublish')
  @HttpCode(200)
  @RequirePermission(Permission.ContentPublish)
  unpublish(
    @CurrentSite() site: SiteAccess,
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ) {
    return this.content.unpublish(site, user, id);
  }
}
