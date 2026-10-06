import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Query,
} from '@nestjs/common';
import {
  InvalidHostError,
  SiteResolver,
  type ResolvedHost,
} from './site-resolver.service.js';

@Controller('sites')
export class SitesController {
  constructor(private readonly resolver: SiteResolver) {}

  /**
   * Public, no login: the website asks this before it knows which site it is serving. The site
   * comes from the address, never from a `siteId` parameter. A missing, repeated (`host=a&host=b`
   * arrives as an array) or malformed host is a 400, decided before any database call.
   */
  @Get('resolve')
  async resolve(@Query('host') host: unknown): Promise<ResolvedHost> {
    let resolved: ResolvedHost | null;
    try {
      resolved = await this.resolver.resolve(host);
    } catch (error) {
      if (error instanceof InvalidHostError) {
        throw new BadRequestException('host must be a valid web address');
      }
      throw error;
    }
    if (!resolved) {
      throw new NotFoundException('No site answers on this address');
    }
    return resolved;
  }
}
