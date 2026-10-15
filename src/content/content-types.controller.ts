import { Body, Controller, Get, Post } from '@nestjs/common';
import {
  CurrentSite,
  RequirePermission,
  SiteScoped,
  type SiteAccess,
} from '../auth/decorators.js';
import { Permission } from '../auth/permission.js';
import { createTypeBody } from './content-type-input.js';
import { parseOr400 } from './content-input.js';
import { ContentService } from './content.service.js';
import { ContentTypesService } from './content-types.service.js';

/**
 * The site's content types (Page, Post, ...): every member may list them (the admin offers them when
 * creating a page); making one needs `content_types.manage` (TYP-01, D-043).
 */
@Controller('content-types')
export class ContentTypesController {
  constructor(
    private readonly content: ContentService,
    private readonly types: ContentTypesService,
  ) {}

  @Get()
  @SiteScoped()
  list(@CurrentSite() site: SiteAccess) {
    return this.content.listTypes(site.siteId);
  }

  @Post()
  @RequirePermission(Permission.ContentTypesManage)
  create(@CurrentSite() site: SiteAccess, @Body() body: unknown) {
    return this.types.create(site.siteId, parseOr400(createTypeBody, body));
  }
}
