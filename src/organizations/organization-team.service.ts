import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { MembersService } from '../members/members.service.js';
import { PlatformRepository } from '../platform/platform.repository.js';

/** What every 404 of the team route says: nothing about which organisations exist. */
export const ORGANIZATION_NOT_FOUND_MESSAGE = 'Organization not found';
export const TEAM_OWNER_ONLY_MESSAGE =
  'Only the owner of an organization can see its team';

type Role = { id: string; name: string };

/** The company team of an organisation, as the owner reads it (organizations T3). */
export type OrganizationTeam = {
  organization: { id: string; name: string };
  /** By name, each with its own five roles. */
  websites: { id: string; name: string; roles: Role[] }[];
  /** Each person once, by name, with their access on each website they are on. */
  people: {
    userId: string;
    name: string;
    email: string;
    isOwner: boolean;
    access: { siteId: string; role: Role }[];
  }[];
  /** The waiting invitations of every website (expired ones too, flagged), by email. */
  invitations: {
    id: string;
    email: string;
    siteId: string;
    role: Role;
    expiresAt: string;
    expired: boolean;
  }[];
};

const byNameThenId = (
  a: { name: string; id: string },
  b: { name: string; id: string },
) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

/**
 * The company team (organizations T3, D-054): who is on the organisation's websites, with their access
 * on each, and the waiting invitations. It is not stored: it is read from each website's own people
 * through the scoped members desk, every read carrying its `siteId`, and merged by person, so someone
 * on no website is on no team.
 *
 * Only the owner reads it. The owner is an Administrator of every website of their organisation (they
 * are made one when they create it and cannot be removed or demoted), so their own memberships in it
 * are the organisation's websites.
 */
@Injectable()
export class OrganizationTeamService {
  constructor(
    private readonly platform: PlatformRepository,
    private readonly members: MembersService,
  ) {}

  /**
   * Throws `ForbiddenException` for a member of one of its websites who is not the owner, and
   * `NotFoundException`, always with the same message, for everyone else: another owner, a stranger, an
   * id nothing has and an id that is not a uuid. The owner check happens before anything is read.
   */
  async team(
    userId: string,
    rawOrganizationId: string,
  ): Promise<OrganizationTeam> {
    const organizationId = rawOrganizationId.toLowerCase();
    const [owned, memberships] = await Promise.all([
      this.platform.findOrganizationsOwnedBy(userId),
      this.platform.findMembershipsByUserId(userId),
    ]);
    const organization = owned.find((item) => item.id === organizationId);
    if (!organization) {
      const isMember = memberships.some(
        ({ site }) => site.organizationId === organizationId,
      );
      throw isMember
        ? new ForbiddenException(TEAM_OWNER_ONLY_MESSAGE)
        : new NotFoundException(ORGANIZATION_NOT_FOUND_MESSAGE);
    }

    const sites = memberships
      .filter(({ site }) => site.organizationId === organizationId)
      .map(({ site }) => ({ id: site.id, name: site.name }))
      .sort(byNameThenId);
    const lists = await Promise.all(
      sites.map((site) => this.members.list(site.id)),
    );

    const people = new Map<string, OrganizationTeam['people'][number]>();
    const invitations: (OrganizationTeam['invitations'][number] & {
      order: number;
    })[] = [];
    sites.forEach((site, order) => {
      const { members, invitations: waiting } = lists[order];
      for (const member of members) {
        const person = people.get(member.userId) ?? {
          userId: member.userId,
          name: member.name,
          email: member.email,
          isOwner: member.isOwner,
          access: [],
        };
        person.access.push({ siteId: site.id, role: member.role });
        people.set(member.userId, person);
      }
      for (const invitation of waiting) {
        invitations.push({
          id: invitation.id,
          email: invitation.email,
          siteId: site.id,
          role: invitation.role,
          expiresAt: invitation.expiresAt,
          expired: invitation.expired,
          order,
        });
      }
    });

    return {
      organization: { id: organization.id, name: organization.name },
      websites: sites.map((site, order) => ({
        ...site,
        roles: lists[order].roles,
      })),
      people: [...people.values()].sort((a, b) =>
        byNameThenId(
          { name: a.name, id: a.userId },
          { name: b.name, id: b.userId },
        ),
      ),
      invitations: invitations
        .sort(
          (a, b) =>
            a.email.localeCompare(b.email) ||
            a.order - b.order ||
            a.id.localeCompare(b.id),
        )
        .map(({ order: _order, ...invitation }) => invitation),
    };
  }
}
