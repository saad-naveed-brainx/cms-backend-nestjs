import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Post,
} from '@nestjs/common';
import { CurrentUser, type AuthUser } from '../auth/decorators.js';
import { ProvisioningService } from './provisioning.service.js';
import {
  HostnameTakenError,
  NotOrganizationOwnerError,
  OrganizationRequiredError,
  ProvisionInputError,
} from './tenant-input.js';

/**
 * Creating a site from the admin (GOV-08a). Both routes need a sign-in and nothing else: they are
 * about the person, not about one site (so no `X-Site-Id`). This is not sign-up: no account is
 * made, and only the owner of an organisation can add a site to it.
 */
@Controller()
export class SiteCreationController {
  constructor(private readonly provisioning: ProvisioningService) {}

  /** The organisations the signed-in person owns. */
  @Get('organizations')
  async organizations(@CurrentUser() user: AuthUser) {
    return { items: await this.provisioning.ownedOrganizations(user.id) };
  }

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

/** The typed failures of site creation as the answers a client can act on. Anything else stays a 500. */
function toHttpError(error: unknown): unknown {
  if (error instanceof ProvisionInputError) {
    return new BadRequestException({
      message: 'Invalid request',
      errors: error.problems,
    });
  }
  if (error instanceof OrganizationRequiredError) {
    return new BadRequestException({
      message: 'Invalid request',
      errors: [`organizationId: ${error.message}`],
    });
  }
  if (error instanceof NotOrganizationOwnerError) {
    return new ForbiddenException(error.message);
  }
  if (error instanceof HostnameTakenError) {
    return new ConflictException(error.message);
  }
  return error;
}
