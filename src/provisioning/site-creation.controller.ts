import { Body, Controller, Post } from '@nestjs/common';
import { CurrentUser, type AuthUser } from '../auth/decorators.js';
import { toHttpError } from './http-errors.js';
import { ProvisioningService } from './provisioning.service.js';

/**
 * Creating a site from the admin (GOV-08a). The route needs a sign-in and nothing else: it is about
 * the person, not about one site (so no `X-Site-Id`). This is not sign-up: no account is made, and
 * only the owner of an organisation can add a site to it. The organisation routes are in
 * `OrganizationsController`.
 */
@Controller()
export class SiteCreationController {
  constructor(private readonly provisioning: ProvisioningService) {}

  /** Adds a site, with its addresses, to an organisation the person owns, and makes them its administrator. */
  @Post('sites')
  async create(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    try {
      return await this.provisioning.provisionSite(user.id, body);
    } catch (error) {
      throw toHttpError(error);
    }
  }
}
