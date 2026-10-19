import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  InvitationRepository,
  type InvitationView,
} from '../invitations/invitation.repository.js';
import {
  SiteMemberRepository,
  type MemberChange,
  type MemberView,
  type RoleSummary,
} from './site-member.repository.js';

export const LAST_ADMIN_MESSAGE = 'A site needs at least one Administrator.';
export const OWNER_STAYS_MESSAGE =
  "The organisation's owner stays an Administrator.";

/**
 * Member management for one site (users-roles T2): the list, a role change and a removal. The
 * safety rules themselves run inside the members desk's locked transaction (plan D6); this turns
 * the desk's answer into HTTP.
 */
@Injectable()
export class MembersService {
  constructor(
    private readonly members: SiteMemberRepository,
    private readonly invitations: InvitationRepository,
  ) {}

  /** The site's roles, its people, and its waiting invitations (newest first, expired ones included). */
  async list(siteId: string): Promise<{
    roles: RoleSummary[];
    members: MemberView[];
    invitations: InvitationView[];
  }> {
    const [roles, members, invitations] = await Promise.all([
      this.members.listRoles(siteId),
      this.members.listMembers(siteId),
      this.invitations.listForSite(siteId),
    ]);
    return { roles, members, invitations };
  }

  async changeRole(
    siteId: string,
    userId: string,
    roleId: string,
  ): Promise<MemberView> {
    const result = await this.members.changeRole(siteId, userId, roleId);
    if (result.outcome === 'changed') return result.member;
    throw toHttpError(result);
  }

  async remove(siteId: string, userId: string): Promise<void> {
    const result = await this.members.removeMember(siteId, userId);
    if (result.outcome === 'removed') return;
    throw toHttpError(result);
  }
}

function toHttpError(result: MemberChange): Error {
  switch (result.outcome) {
    case 'role-not-found':
      return new BadRequestException(
        "That role is not one of this site's roles.",
      );
    case 'last-admin':
      return new ConflictException(LAST_ADMIN_MESSAGE);
    case 'owner-stays':
      return new ConflictException(OWNER_STAYS_MESSAGE);
    default:
      return new NotFoundException('Not a member of this site');
  }
}
