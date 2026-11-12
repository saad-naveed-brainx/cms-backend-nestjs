import { Controller, Get, Param } from '@nestjs/common';
import { CurrentUser, type AuthUser } from '../auth/decorators.js';
import { ProvisioningService } from '../provisioning/provisioning.service.js';
import { OrganizationTeamService } from './organization-team.service.js';

/**
 * The routes about the organisations a person owns. Like `POST /sites` they need a sign-in and no
 * `X-Site-Id`: they are about the person, not about one site. An organisation is made by the platform's
 * super admin (`POST /platform/organizations`, D-062); no ordinary person makes one.
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
}
