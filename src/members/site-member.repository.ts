import { Injectable } from '@nestjs/common';
import { DataSource, type Repository } from 'typeorm';
import type { Permission } from '../auth/permission.js';
import { Role, SiteMember } from '../database/entities/index.js';
import {
  ScopedRepository,
  isUuid,
  requireSiteId,
} from '../database/scoped.repository.js';

/** What a member's role lets them do on one site. */
export type MemberAccess = {
  roleId: string;
  roleName: string;
  permissions: Permission[];
};

/**
 * The members desk: who belongs to a site and with which role (`site_members`), one site at a time.
 * `SiteAccessGuard` asks it on every site-scoped request what the signed-in user may do there.
 * The cross-site question, "which sites does this user belong to?", is on the platform desk.
 */
@Injectable()
export class SiteMemberRepository extends ScopedRepository<SiteMember> {
  private readonly members: Repository<SiteMember>;

  constructor(dataSource: DataSource) {
    super(dataSource, SiteMember);
    this.members = dataSource.getRepository(SiteMember);
  }

  /**
   * The user's role on this site and its permissions, in one query, or `null` when the user is not
   * a member of it. A site that does not exist gives the same `null`. The role is joined on
   * `(site_id, role_id)` and both rows must be on the site, so another site's role never shows.
   *
   * Checked before any SQL: the site id (an error, like every desk method), then the user id (a
   * malformed one cannot belong to anyone: `null`).
   */
  async findAccess(
    siteId: string,
    userId: string,
  ): Promise<MemberAccess | null> {
    requireSiteId(siteId);
    if (!isUuid(userId)) return null;

    const row = await this.members
      .createQueryBuilder('member')
      .innerJoin(
        Role,
        'role',
        'role.siteId = member.siteId AND role.id = member.roleId',
      )
      .select('role.id', 'roleId')
      .addSelect('role.name', 'roleName')
      // `pg` hands an enum array back as the text `{a,b}`; as text[] it arrives as an array.
      .addSelect('"role"."permissions"::text[]', 'permissions')
      .where('member.siteId = :siteId', { siteId })
      .andWhere('role.siteId = :siteId', { siteId })
      .andWhere('member.userId = :userId', { userId })
      .getRawOne<{
        roleId: string;
        roleName: string;
        permissions: Permission[];
      }>();

    return row ?? null;
  }
}
