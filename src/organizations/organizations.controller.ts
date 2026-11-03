import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { CurrentUser, type AuthUser } from '../auth/decorators.js';
import { toHttpError } from '../provisioning/http-errors.js';
import { ProvisioningService } from '../provisioning/provisioning.service.js';
import { OrganizationTeamService } from './organization-team.service.js';

/**
 * The routes about organisations (organizations T2). Like `POST /sites` they need a sign-in and no
 * `X-Site-Id`: they are about the person, not about one site.
 */
@Controller('organizations')
export class OrganizationsController {
  constructor(
    private readonly provisioning: ProvisioningService,
    private readonly teams: OrganizationTeamService,
  ) {}

  /** The organisations the signed-in person owns, by name. */
  @Get()
  async owned(@CurrentUser() user: AuthUser) {
    return { items: await this.provisioning.ownedOrganizations(user.id) };
  }

  /**
   * The company team of an organisation the signed-in person owns: its websites, the people on them
   * with their access, and the waiting invitations (organizations T3, D-054). 200 for the owner, 403
   * for a member who is not, and one 404 for everyone else.
   */
  @Get(':id/team')
  team(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.teams.team(user.id, id);
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
