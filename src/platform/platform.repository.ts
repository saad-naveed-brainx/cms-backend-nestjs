import { Injectable } from '@nestjs/common';
import { DataSource, type Repository } from 'typeorm';
import type { Permission } from '../auth/permission.js';
import {
  Hostname,
  Organization,
  Role,
  Site,
  SiteMember,
  User,
} from '../database/entities/index.js';
import { isUuid } from '../database/scoped.repository.js';

/** One site a user belongs to, with their role there. */
export type UserMembership = {
  site: { id: string; name: string };
  role: { id: string; name: string; permissions: Permission[] };
};

/**
 * The platform desk: the ONE desk allowed to read across sites, and the only repository that does
 * not extend `ScopedRepository`.
 *
 * It exists because a few questions are asked before any site is known: which site answers on this
 * web address, which user has this email or id (to log in and to say who is signed in), and which
 * sites a user belongs to. None has a `siteId` to start from, so none can go through a scoped desk.
 * The alternative, an unscoped escape hatch on every desk, would make every call site a place to
 * forget the site. So these exceptions live here, in one place a reviewer can see at once
 * (invariant 1; docs/DECISIONS.md D-015 and D-018; brief decision Q3).
 *
 * Kept narrow on purpose:
 * - It covers `sites`, `hostnames`, `users` and `organizations` only: the shared tables, plus a user's
 *   membership rows (`site_members` and the role each points at), read only by user, and the
 *   organisations a user owns. Whatever a site owns
 *   (pages, media, menus, ...) stays behind the scoped desks, and so does one site's member list.
 * - It has exactly five methods, because a sixth would be a sixth unscoped query.
 *   test/platform-repository.spec.ts pins the list, private methods included: a helper belongs in
 *   a plain function outside this class, not on it.
 * - The address and email lookups lower-case their input and do nothing else: no trimming, no port
 *   stripping, no `www.` fallback. The tables store lower case, and tidying a raw Host header is
 *   FND-04's job. Every match is exact, never a pattern, and values are always bound parameters.
 *   The two lookups by user id send nothing for a malformed id.
 * - It keeps no state between calls and caches nothing: host-to-site caching is FND-04's.
 */
@Injectable()
export class PlatformRepository {
  private readonly sites: Repository<Site>;
  private readonly users: Repository<User>;
  private readonly organizations: Repository<Organization>;

  constructor(dataSource: DataSource) {
    this.sites = dataSource.getRepository(Site);
    this.users = dataSource.getRepository(User);
    this.organizations = dataSource.getRepository(Organization);
  }

  /**
   * The site that answers on this web address, whether it is the site's primary address or one of
   * its others, with its whole row (theme and settings included). `null` when none does.
   */
  async findSiteByHostname(hostname: string): Promise<Site | null> {
    return this.sites
      .createQueryBuilder('site')
      .innerJoin(Hostname, 'hostname', 'hostname.siteId = site.id')
      .where('hostname.hostname = :hostname', {
        hostname: hostname.toLowerCase(),
      })
      .getOne();
  }

  /**
   * The user with this email, with their whole row: the stored password hash is included, because
   * the login step needs it. `null` when no user has it.
   */
  async findUserByEmail(email: string): Promise<User | null> {
    return this.users.findOneBy({ email: email.toLowerCase() });
  }

  /**
   * The user with this id, with their whole row, password hash included. `null` when none has it,
   * and for an id that is not a uuid (no query is sent).
   */
  async findUserById(userId: string): Promise<User | null> {
    if (!isUuid(userId)) return null;
    return this.users.findOneBy({ id: userId });
  }

  /**
   * Every site this user belongs to, with their role there and its permissions, ordered by site
   * name. Empty when they belong to none, and for an id that is not a uuid (no query is sent).
   * One query: the role is joined on `(site_id, role_id)`, so it is always the site's own role.
   */
  async findMembershipsByUserId(userId: string): Promise<UserMembership[]> {
    if (!isUuid(userId)) return [];

    const rows = await this.sites
      .createQueryBuilder('site')
      .innerJoin(SiteMember, 'member', 'member.siteId = site.id')
      .innerJoin(
        Role,
        'role',
        'role.siteId = member.siteId AND role.id = member.roleId',
      )
      .select('site.id', 'siteId')
      .addSelect('site.name', 'siteName')
      .addSelect('role.id', 'roleId')
      .addSelect('role.name', 'roleName')
      // `pg` hands an enum array back as the text `{a,b}`; as text[] it arrives as an array.
      .addSelect('"role"."permissions"::text[]', 'permissions')
      .where('member.userId = :userId', { userId })
      .orderBy('site.name', 'ASC')
      .addOrderBy('site.id', 'ASC')
      .getRawMany<MembershipRow>();

    return rows.map(toMembership);
  }

  /**
   * The organisations this user owns, ordered by name. Empty when they own none, and for an id that
   * is not a uuid (no query is sent). Only the id and name leave: it answers "which organisation
   * may this person add a site to" (GOV-08a).
   */
  async findOrganizationsOwnedBy(
    userId: string,
  ): Promise<{ id: string; name: string }[]> {
    if (!isUuid(userId)) return [];
    const rows = await this.organizations.find({
      where: { ownerId: userId },
      order: { name: 'ASC', id: 'ASC' },
    });
    return rows.map(({ id, name }) => ({ id, name }));
  }
}

type MembershipRow = {
  siteId: string;
  siteName: string;
  roleId: string;
  roleName: string;
  permissions: Permission[];
};

function toMembership(row: MembershipRow): UserMembership {
  return {
    site: { id: row.siteId, name: row.siteName },
    role: {
      id: row.roleId,
      name: row.roleName,
      permissions: row.permissions,
    },
  };
}
