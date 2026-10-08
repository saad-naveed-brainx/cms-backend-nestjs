import { Controller, Get } from '@nestjs/common';
import {
  CurrentSite,
  SiteScoped,
  type SiteAccess,
} from '../auth/decorators.js';
import { ContentService } from './content.service.js';

/** The site's content types (Page, Post, ...), for every member: the admin offers them when creating a page. */
@Controller('content-types')
export class ContentTypesController {
  constructor(private readonly content: ContentService) {}

  @Get()
  @SiteScoped()
  list(@CurrentSite() site: SiteAccess) {
    return this.content.listTypes(site.siteId);
  }
}
