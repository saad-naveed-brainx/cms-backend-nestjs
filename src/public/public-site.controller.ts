import { Controller, Get, Header, Query } from '@nestjs/common';
import { Public } from '../auth/decorators.js';
import {
  PublicSiteService,
  type PublicListingView,
  type PublicPreviewView,
  type PublicSiteView,
} from './public-site.service.js';

@Controller('public')
export class PublicSiteController {
  constructor(private readonly service: PublicSiteService) {}

  /**
   * Public, no login: the website asks this for every page it draws. The site comes from the
   * address (`host`), never from an id; the answer is the published page at `path` (`/` is the
   * home page, `kind: 'page'`), or, at a type's own address with no page there (`/blog`), that
   * type's published items newest first (`kind: 'listing'`, `page` counting from 1). A missing or
   * malformed `host`, `path` or `page` is a 400; an unknown address, a path with no published
   * page, a draft, a trashed page, another site's page and a blog page past the end are a 404.
   */
  @Public()
  @Get('site')
  site(
    @Query('host') host: unknown,
    @Query('path') path: unknown,
    @Query('page') page: unknown,
  ): Promise<PublicSiteView | PublicListingView> {
    return this.service.lookUp(host, path, page);
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
