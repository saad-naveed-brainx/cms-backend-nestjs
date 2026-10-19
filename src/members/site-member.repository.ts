import { Injectable } from '@nestjs/common';
import { DataSource, type EntityManager, type Repository } from 'typeorm';
import { Permission } from '../auth/permission.js';
import { ROLE_DEFINITIONS } from '../auth/roles.js';
import {
  Organization,
  Role,
  Site,
  SiteMember,
  User,
} from '../database/entities/index.js';
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

/** A role as the Users screen shows it. */
export type RoleSummary = { id: string; name: string };

/** One person on a site: their account's name and email (never the password hash) and their role here. */
export type MemberView = {
  userId: string;
  name: string;
  email: string;
  role: RoleSummary;
  isOwner: boolean;
};

/** Why a role change or a removal was refused, or what it did. */
export type MemberChange =
  | { outcome: 'changed'; member: MemberView }
  | { outcome: 'removed' }
  | { outcome: 'not-found' }
  | { outcome: 'role-not-found' }
  | { outcome: 'last-admin' }
  | { outcome: 'owner-stays' };

/** The rule's answer before anything is written: allowed, or which rule refuses it. */
type SafetyCheck =
  | { outcome: 'allowed' }
  | { outcome: 'last-admin' }
  | { outcome: 'owner-stays' };

/** Where a role sits in `ROLE_DEFINITIONS`; a role not named there goes after them. */
function definitionRank(name: string): number {
  const index = ROLE_DEFINITIONS.findIndex((role) => role.name === name);
  return index === -1 ? ROLE_DEFINITIONS.length : index;
}

/**
 * The members desk: who belongs to a site and with which role (`site_members`), one site at a time.
 * `SiteAccessGuard` asks it on every site-scoped request what the signed-in user may do there.
 * The cross-site question, "which sites does this user belong to?", is on the platform desk.
 */
@Injectable()
export class SiteMemberRepository extends ScopedRepository<SiteMember> {
  private readonly members: Repository<SiteMember>;

  constructor(private readonly dataSource: DataSource) {
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

  /** The site's roles, in `ROLE_DEFINITIONS` order (any other role after them, by name). */
  async listRoles(siteId: string): Promise<RoleSummary[]> {
    requireSiteId(siteId);
    const roles = await this.dataSource
      .getRepository(Role)
      .find({ where: { siteId }, order: { name: 'ASC', id: 'ASC' } });
    return roles
      .map((role) => ({ id: role.id, name: role.name }))
      .sort((a, b) => definitionRank(a.name) - definitionRank(b.name));
  }

  /**
   * The site's people, by name then id. Users are reached only through this site's own
   * `site_members` rows, so nobody from another site can appear.
   */
  async listMembers(siteId: string): Promise<MemberView[]> {
    requireSiteId(siteId);
    return this.readMembers(this.dataSource.manager, siteId);
  }

  /**
   * Gives a member another of this site's roles, under the safety rules (plan D6). Changing to
   * the role they already hold changes nothing and answers the member.
   */
  changeRole(
    siteId: string,
    userId: string,
    roleId: string,
  ): Promise<MemberChange> {
    requireSiteId(siteId);
    if (!isUuid(userId)) return Promise.resolve({ outcome: 'not-found' });

    return this.dataSource.transaction(async (manager) => {
      const state = await this.lockAndRead(manager, siteId, userId);
      if (!state) return { outcome: 'not-found' };

      const newRole = isUuid(roleId)
        ? await manager.findOneBy(Role, { siteId, id: roleId })
        : null;
      if (!newRole) return { outcome: 'role-not-found' };

      if (newRole.id !== state.member.roleId) {
        const check = this.checkSafety(state, holdsManage(newRole));
        if (check.outcome !== 'allowed') return check;
        await manager.update(
          SiteMember,
          { siteId, userId },
          { roleId: newRole.id },
        );
      }

      const [member] = await this.readMembers(manager, siteId, userId);
      return member ? { outcome: 'changed', member } : { outcome: 'not-found' };
    });
  }

  /**
   * Removes a member from this site, under the safety rules (plan D6). Their account, their
   * other sites and the pages they wrote stay.
   */
  removeMember(siteId: string, userId: string): Promise<MemberChange> {
    requireSiteId(siteId);
    if (!isUuid(userId)) return Promise.resolve({ outcome: 'not-found' });

    return this.dataSource.transaction(async (manager) => {
      const state = await this.lockAndRead(manager, siteId, userId);
      if (!state) return { outcome: 'not-found' };

      const check = this.checkSafety(state, false);
      if (check.outcome !== 'allowed') return check;

      await manager.delete(SiteMember, { siteId, userId });
      return { outcome: 'removed' };
    });
  }

  /**
   * The first step of every change (plan D6): the site's row is locked (`SELECT … FOR UPDATE`),
   * so a second change on the same site waits here until the first commits and then reads its
   * result. Then, under that lock: the target's membership and current role, the organisation's
   * owner, and how many members hold `members.manage`. `null` when the site or the membership
   * is not there.
   */
  private async lockAndRead(
    manager: EntityManager,
    siteId: string,
    userId: string,
  ): Promise<MemberState | null> {
    const site = await manager.findOne(Site, {
      where: { id: siteId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!site) return null;

    const member = await manager.findOneBy(SiteMember, { siteId, userId });
    if (!member) return null;

    const currentRole = await manager.findOneBy(Role, {
      siteId,
      id: member.roleId,
    });
    const organization = await manager.findOneBy(Organization, {
      id: site.organizationId,
    });
    const managers = await manager
      .createQueryBuilder(SiteMember, 'member')
      .innerJoin(
        Role,
        'role',
        'role.siteId = member.siteId AND role.id = member.roleId',
      )
      .where('member.siteId = :siteId', { siteId })
      .andWhere('role.siteId = :siteId', { siteId })
      .andWhere(':manage = ANY("role"."permissions")', {
        manage: Permission.MembersManage,
      })
      .getCount();

    return {
      member,
      isAdmin: currentRole ? holdsManage(currentRole) : false,
      isOwner: organization?.ownerId === userId,
      managers,
    };
  }

  /**
   * The two rules, checked in this order: the organisation's owner must keep `members.manage`
   * (so may not be demoted below it or removed), and a change that takes `members.manage` away
   * from the only member holding it is refused.
   */
  private checkSafety(state: MemberState, keepsManage: boolean): SafetyCheck {
    if (state.isOwner && !keepsManage) return { outcome: 'owner-stays' };
    if (state.isAdmin && !keepsManage && state.managers <= 1) {
      return { outcome: 'last-admin' };
    }
    return { outcome: 'allowed' };
  }

  /** The site's people (or the one named), each with their role and whether they own the organisation. */
  private async readMembers(
    manager: EntityManager,
    siteId: string,
    userId?: string,
  ): Promise<MemberView[]> {
    const query = manager
      .createQueryBuilder(SiteMember, 'member')
      .innerJoin(
        Role,
        'role',
        'role.siteId = member.siteId AND role.id = member.roleId',
      )
      .innerJoin(User, 'person', 'person.id = member.userId')
      .innerJoin(Site, 'site', 'site.id = member.siteId')
      .innerJoin(Organization, 'org', 'org.id = site.organizationId')
      .select('person.id', 'userId')
      .addSelect('person.name', 'name')
      .addSelect('person.email', 'email')
      .addSelect('role.id', 'roleId')
      .addSelect('role.name', 'roleName')
      .addSelect('org.ownerId = person.id', 'isOwner')
      .where('member.siteId = :siteId', { siteId })
      .andWhere('role.siteId = :siteId', { siteId })
      .orderBy('person.name', 'ASC')
      .addOrderBy('person.id', 'ASC');
    if (userId) query.andWhere('member.userId = :userId', { userId });

    const rows = await query.getRawMany<{
      userId: string;
      name: string;
      email: string;
      roleId: string;
      roleName: string;
      isOwner: boolean;
    }>();
    return rows.map((row) => ({
      userId: row.userId,
      name: row.name,
      email: row.email,
      role: { id: row.roleId, name: row.roleName },
      isOwner: row.isOwner === true,
    }));
  }
}

/** What a change needs to know about its target, read under the site's lock. */
type MemberState = {
  member: SiteMember;
  /** The target's current role holds `members.manage`. */
  isAdmin: boolean;
  /** The target owns the site's organisation. */
  isOwner: boolean;
  /** How many of the site's members hold `members.manage`, the target included. */
  managers: number;
};

/** The role holds `members.manage`. `pg` may hand an enum array back as the text `{a,b}`, so both forms are read. */
function holdsManage(role: Role): boolean {
  const permissions: unknown = role.permissions;
  const list =
    typeof permissions === 'string'
      ? permissions.replace(/^\{|\}$/g, '').split(',')
      : (permissions as string[]);
  return list.includes(Permission.MembersManage);
}
