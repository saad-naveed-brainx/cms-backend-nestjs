import { Controller, Get, Query } from '@nestjs/common';
import { Public } from '../auth/decorators.js';
import {
  PublicSiteService,
  type PublicSiteView,
} from './public-site.service.js';

@Controller('public')
export class PublicSiteController {
  constructor(private readonly service: PublicSiteService) {}

  /**
   * Public, no login: the website asks this for every page it draws. The site comes from the
   * address (`host`), never from an id; the page is the published one at `path` (`/` is the home
   * page). A missing or malformed `host` or `path` is a 400; an unknown address, a path with no
   * published page, a draft, a trashed page and another site's page are all a 404.
   */
  @Public()
  @Get('site')
  site(
    @Query('host') host: unknown,
    @Query('path') path: unknown,
  ): Promise<PublicSiteView> {
    return this.service.lookUp(host, path);
  }
}
