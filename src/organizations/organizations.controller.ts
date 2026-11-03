import { Body, Controller, Get, Post } from '@nestjs/common';
import { CurrentUser, type AuthUser } from '../auth/decorators.js';
import { toHttpError } from '../provisioning/http-errors.js';
import { ProvisioningService } from '../provisioning/provisioning.service.js';

/**
 * The routes about organisations (organizations T2). Like `POST /sites` they need a sign-in and no
 * `X-Site-Id`: they are about the person, not about one site.
 */
@Controller('organizations')
export class OrganizationsController {
  constructor(private readonly provisioning: ProvisioningService) {}

  /** The organisations the signed-in person owns, by name. */
  @Get()
  async owned(@CurrentUser() user: AuthUser) {
    return { items: await this.provisioning.ownedOrganizations(user.id) };
  }

  /**
   * Makes an organisation owned by the signed-in person, who may then add websites to it. Any
   * signed-in person may, with no limit (D-056). 201 `{ id, name }`.
   */
  @Post()
  async create(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    try {
      return await this.provisioning.createOrganization(user.id, body);
    } catch (error) {
      throw toHttpError(error);
    }
  }
}
