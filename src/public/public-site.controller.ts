import { Controller, Get, Header, Query } from '@nestjs/common';
import { Public } from '../auth/decorators.js';
import {
  PublicSiteService,
  type PublicPreviewView,
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

  /**
   * Public, no login: a preview link opened on the website (`?preview=<token>`). The token names
   * one page of one site; the address must be that site's. Never stored by a cache, never indexed.
   * A bad or expired token is a 401; a good one at another site's address is a 404.
   */
  @Public()
  @Get('preview')
  @Header('Cache-Control', 'no-store')
  preview(
    @Query('host') host: unknown,
    @Query('token') token: unknown,
  ): Promise<PublicPreviewView> {
    return this.service.preview(host, token);
  }
}
