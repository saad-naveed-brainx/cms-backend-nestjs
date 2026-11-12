import { Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { ADMINISTRATOR_ROLE } from '../auth/roles.js';
import {
  Organization,
  OrganizationInvitation,
  Role,
  Site,
  SiteMember,
  User,
} from '../database/entities/index.js';
import { isUuid } from '../database/scoped.repository.js';
import { isUserEmailTaken } from '../database/unique-email-violation.js';

/** What `grantPlatformAdmin` did for an email. */
export type GrantedPlatformAdmin = {
  id: string;
  email: string;
  /** `true` when the account was made by this call; `false` when it already existed. */
  created: boolean;
};

/** One organisation as the platform's list shows it. */
export type OrganizationRow = {
  id: string;
  name: string;
  createdAt: Date;
  suspendedAt: Date | null;
  ownerId: string | null;
  ownerEmail: string | null;
  ownerName: string | null;
  /** The email an owner invitation waits for, when the organisation has no owner yet. */
  pendingOwnerEmail: string | null;
  websites: number;
};

/** The new organisation: its owner is an existing account, or an invitation that waits for one. */
export type NewOrganization = {
  name: string;
  invitedBy: string;
  owner:
    | { userId: string }
    | { email: string; name: string; tokenHash: string; expiresAt: Date };
};

/** An owner invitation found by its link: what the invite page shows and what accepting needs. */
export type FoundOwnerInvitation = {
  id: string;
  organizationId: string;
  organizationName: string;
  email: string;
  /** The new owner's name, as the super admin gave it. */
  name: string;
  expiresAt: Date;
  /** A user with the invitation's email exists now. */
  hasAccount: boolean;
};

/** Who accepts an owner link: a new account (password already hashed), or the existing one with this id. */
export type OwnerAcceptor =
  | { kind: 'new'; name: string; passwordHash: string }
  | { kind: 'existing'; userId: string };

/** What accepting did, or why nothing was written. */
export type OwnerAcceptance =
  | { outcome: 'accepted'; userId: string }
  /** No such link any more (used, replaced, organisation gone or already owned) or it expired. */
  | { outcome: 'invalid' }
  /** A new account was asked for, but one with that email exists now. Link kept. */
  | { outcome: 'account-exists' }
  /** The existing account named is gone or no longer has the invitation's email. Link kept. */
  | { outcome: 'account-gone' };

/**
 * The platform-admin desk (platform-admin plan D3, D-062): the third place allowed to read across
 * organisations, after the platform desk and the site-removal desk. It covers `users`, `organizations`
 * and `organization_invitations` only; whatever a website owns is reached through that website's scoped
 * desks, one `siteId` at a time, with one named exception: accepting an owner link, in one transaction with
 * the new owner's account, gives them the Administrator role on the websites the organisation already has. `test/platform-admin-repository.spec.ts` pins its method list: a new
 * method here is a new unscoped query and needs a deliberate change to that test.
 */
@Injectable()
export class PlatformAdminRepository {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Makes the account with this email a super admin. An existing account keeps its name and password
   * (only the flag is set). With no account, `account` makes one (already hashed); without it `null`
   * is returned and nothing is written. One transaction.
   */
  async grantPlatformAdmin(
    email: string,
    account: { name: string; passwordHash: string } | null,
  ): Promise<GrantedPlatformAdmin | null> {
    return this.dataSource.transaction(async (manager) => {
      const existing = await manager.findOneBy(User, { email });
      if (existing) {
        if (!existing.isPlatformAdmin) {
          await manager.update(
            User,
            { id: existing.id },
            { isPlatformAdmin: true },
          );
        }
        return { id: existing.id, email, created: false };
      }
      if (!account) return null;
      const user = await manager.save(
        manager.create(User, {
          email,
          name: account.name,
          passwordHash: account.passwordHash,
          isPlatformAdmin: true,
        }),
      );
      return { id: user.id, email, created: true };
    });
  }

  /** Takes the flag off the account with this email. `false` when there is no such account. */
  async revokePlatformAdmin(email: string): Promise<boolean> {
    const result = await this.dataSource
      .getRepository(User)
      .update({ email }, { isPlatformAdmin: false });
    return (result.affected ?? 0) > 0;
  }

  /**
   * Every organisation, by name then id, with its owner (or the email its owner invitation waits
   * for) and how many websites it has. Counts the sites table only: nothing a website owns.
   */
  async listOrganizations(): Promise<OrganizationRow[]> {
    const rows = await this.dataSource.query<
      {
        id: string;
        name: string;
        created_at: Date;
        suspended_at: Date | null;
        owner_id: string | null;
        owner_email: string | null;
        owner_name: string | null;
        pending_email: string | null;
        websites: number;
      }[]
    >(
      `SELECT o.id, o.name, o.created_at, o.suspended_at, o.owner_id,
              u.email AS owner_email, u.name AS owner_name, i.email AS pending_email,
              (SELECT count(*)::int FROM sites s WHERE s.organization_id = o.id) AS websites
         FROM organizations o
         LEFT JOIN users u ON u.id = o.owner_id
         LEFT JOIN organization_invitations i ON i.organization_id = o.id
        ORDER BY lower(o.name), o.name, o.id`,
    );
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      createdAt: row.created_at,
      suspendedAt: row.suspended_at,
      ownerId: row.owner_id,
      ownerEmail: row.owner_email,
      ownerName: row.owner_name,
      pendingOwnerEmail: row.pending_email,
      websites: row.websites,
    }));
  }

  /**
   * Makes the organisation, in one transaction: owned by an existing account, or with no owner and
   * the owner invitation that will give it one (only the secret's fingerprint is stored).
   */
  async createOrganization(
    data: NewOrganization,
  ): Promise<{ id: string; name: string }> {
    return this.dataSource.transaction(async (manager) => {
      const owned = 'userId' in data.owner;
      const organization = await manager.save(
        manager.create(Organization, {
          name: data.name,
          ownerId: 'userId' in data.owner ? data.owner.userId : null,
          suspendedAt: null,
        }),
      );
      if (!owned && 'email' in data.owner) {
        await manager.save(
          manager.create(OrganizationInvitation, {
            organizationId: organization.id,
            email: data.owner.email,
            name: data.owner.name,
            tokenHash: data.owner.tokenHash,
            expiresAt: data.owner.expiresAt,
            invitedBy: data.invitedBy,
          }),
        );
      }
      return { id: organization.id, name: organization.name };
    });
  }

  /**
   * Suspends or reactivates an organisation. A suspended one keeps the date of its first suspension if
   * suspended again. Answers the ids and web addresses of its websites, so the caller can make every
   * cache forget them, or `null` when there is no such organisation (a malformed id too).
   */
  async setSuspended(
    organizationId: string,
    suspended: boolean,
  ): Promise<{ siteIds: string[]; hostnames: string[] } | null> {
    if (!isUuid(organizationId)) return null;
    return this.dataSource.transaction(async (manager) => {
      const updated = (await manager.query(
        suspended
          ? `UPDATE organizations SET suspended_at = COALESCE(suspended_at, now()) WHERE id = $1 RETURNING id`
          : `UPDATE organizations SET suspended_at = NULL WHERE id = $1 RETURNING id`,
        [organizationId],
      )) as unknown[];
      // `UPDATE … RETURNING` answers `[rows, count]` from the pg driver.
      const rows = (
        Array.isArray(updated[0]) ? updated[0] : updated
      ) as unknown[];
      if (rows.length === 0) return null;
      const sites = await manager.find(Site, {
        where: { organizationId },
        select: { id: true },
      });
      const siteIds = sites.map((site) => site.id);
      const hostnames =
        siteIds.length === 0
          ? []
          : (
              (await manager.query(
                `SELECT hostname FROM hostnames WHERE site_id = ANY($1)`,
                [siteIds],
              )) as { hostname: string }[]
            ).map((row) => row.hostname);
      return { siteIds, hostnames };
    });
  }

  /**
   * Hands the organisation to an existing account at once (D-062): they become owner and Administrator on
   * every website, a waiting owner link is withdrawn, and the old owner is taken off the websites when
   * `removeOld` says so. One transaction. `false` when there is no such organisation.
   */
  async assignOwner(
    organizationId: string,
    userId: string,
    removeOld: boolean,
  ): Promise<boolean> {
    if (!isUuid(organizationId)) return false;
    return this.dataSource.transaction(async (manager) => {
      const organization = await manager.findOne(Organization, {
        where: { id: organizationId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!organization) return false;
      await manager.delete(OrganizationInvitation, { organizationId });
      await makeOwner(manager, organization, userId, removeOld);
      return true;
    });
  }

  /**
   * Deletes an organisation for good, in ONE transaction: every one of its websites (the rows they own
   * go with them, `ON DELETE CASCADE`, as when one website is deleted, D-039) and then the organisation,
   * its waiting owner link with it. Accounts stay. `not-found` for no such organisation, `name-mismatch`
   * when `confirmName` is not exactly its name (nothing is deleted then); otherwise the ids and web
   * addresses of the websites that went, so every cache can forget them.
   */
  async deleteOrganization(
    organizationId: string,
    confirmName: string,
  ): Promise<
    | { outcome: 'not-found' }
    | { outcome: 'name-mismatch' }
    | { outcome: 'deleted'; siteIds: string[]; hostnames: string[] }
  > {
    if (!isUuid(organizationId)) return { outcome: 'not-found' };
    return this.dataSource.transaction(async (manager) => {
      const organization = await manager.findOne(Organization, {
        where: { id: organizationId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!organization) return { outcome: 'not-found' } as const;
      if (organization.name !== confirmName)
        return { outcome: 'name-mismatch' } as const;
      const sites = await manager.findBy(Site, { organizationId });
      const siteIds = sites.map((site) => site.id);
      const hostnames =
        siteIds.length === 0
          ? []
          : (
              (await manager.query(
                `SELECT hostname FROM hostnames WHERE site_id = ANY($1)`,
                [siteIds],
              )) as { hostname: string }[]
            ).map((row) => row.hostname);
      for (const siteId of siteIds) await manager.delete(Site, { id: siteId });
      await manager.delete(Organization, { id: organizationId });
      return { outcome: 'deleted', siteIds, hostnames } as const;
    });
  }

  /**
   * Makes a fresh owner invitation for an organisation, replacing the waiting one (a new row, link and
   * expiry). An organisation that has an owner keeps them until the link is used (a handover, D-062).
   * `false` when there is no such organisation.
   */
  async issueOwnerInvitation(
    organizationId: string,
    data: {
      email: string;
      name: string;
      tokenHash: string;
      expiresAt: Date;
      invitedBy: string;
      removePreviousOwner?: boolean;
    },
  ): Promise<boolean> {
    if (!isUuid(organizationId)) return false;
    return this.dataSource.transaction(async (manager) => {
      const organization = await manager.findOne(Organization, {
        where: { id: organizationId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!organization) return false;
      await manager.delete(OrganizationInvitation, { organizationId });
      await manager.save(
        manager.create(OrganizationInvitation, {
          organizationId,
          removePreviousOwner: false,
          ...data,
        }),
      );
      return true;
    });
  }

  /**
   * The owner invitation whose secret hashes to `tokenHash`, with its organisation's name and whether its
   * email has an account. An expired one is returned (the caller decides); a malformed hash is `null`
   * before any SQL.
   */
  async findOwnerInvitationByTokenHash(
    tokenHash: string,
  ): Promise<FoundOwnerInvitation | null> {
    if (!/^[0-9a-f]{64}$/.test(tokenHash)) return null;
    const rows = await this.dataSource.query<
      {
        id: string;
        organization_id: string;
        organization_name: string;
        email: string;
        name: string;
        expires_at: Date;
        has_account: boolean;
      }[]
    >(
      `SELECT i.id, i.organization_id, o.name AS organization_name, i.email, i.name, i.expires_at,
              EXISTS (SELECT 1 FROM users u WHERE u.email = i.email) AS has_account
         FROM organization_invitations i
         JOIN organizations o ON o.id = i.organization_id
        WHERE i.token_hash = $1`,
      [tokenHash],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      organizationId: row.organization_id,
      organizationName: row.organization_name,
      email: row.email,
      name: row.name,
      expiresAt: new Date(row.expires_at),
      hasAccount: row.has_account === true,
    };
  }

  /**
   * Accepts an owner link in ONE transaction: lock the invitation row (a second accept waits and finds it
   * gone), re-check it and its organisation, create or check the account, make that person the owner,
   * make them Administrator on each of the organisation's websites (a member of another role is raised to
   * it), and delete the invitation. A new account whose email was taken meanwhile is `account-exists`
   * with nothing written.
   */
  async acceptOwnerInvitation(
    tokenHash: string,
    acceptor: OwnerAcceptor,
  ): Promise<OwnerAcceptance> {
    if (!/^[0-9a-f]{64}$/.test(tokenHash)) return { outcome: 'invalid' };
    if (acceptor.kind === 'existing' && !isUuid(acceptor.userId)) {
      return { outcome: 'account-gone' };
    }
    try {
      return await this.dataSource.transaction(async (manager) => {
        const invitation = await manager.findOne(OrganizationInvitation, {
          where: { tokenHash },
          lock: { mode: 'pessimistic_write' },
        });
        if (!invitation || invitation.expiresAt.getTime() <= Date.now()) {
          return { outcome: 'invalid' } as const;
        }
        const organization = await manager.findOne(Organization, {
          where: { id: invitation.organizationId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!organization) return { outcome: 'invalid' } as const;

        let userId: string;
        if (acceptor.kind === 'new') {
          if (await manager.existsBy(User, { email: invitation.email })) {
            return { outcome: 'account-exists' } as const;
          }
          const user = await manager.save(
            manager.create(User, {
              email: invitation.email,
              name: acceptor.name,
              passwordHash: acceptor.passwordHash,
            }),
          );
          userId = user.id;
        } else {
          const exists = await manager.existsBy(User, {
            id: acceptor.userId,
            email: invitation.email,
          });
          if (!exists) return { outcome: 'account-gone' } as const;
          userId = acceptor.userId;
        }

        await makeOwner(
          manager,
          organization,
          userId,
          invitation.removePreviousOwner,
        );

        await manager.delete(OrganizationInvitation, { id: invitation.id });
        return { outcome: 'accepted', userId } as const;
      });
    } catch (error) {
      if (isUserEmailTaken(error)) return { outcome: 'account-exists' };
      throw error;
    }
  }
}

/**
 * Makes `userId` the organisation's owner and an Administrator on each of its websites (a member of a
 * lower role is raised), and, when asked, takes the previous owner off those websites. Runs inside the
 * caller's transaction.
 */
async function makeOwner(
  manager: EntityManager,
  organization: Organization,
  userId: string,
  removePrevious: boolean,
): Promise<void> {
  const previousOwnerId = organization.ownerId;
  await manager.update(
    Organization,
    { id: organization.id },
    { ownerId: userId },
  );
  const sites = await manager.findBy(Site, { organizationId: organization.id });
  for (const site of sites) {
    const administrator = await manager.findOneByOrFail(Role, {
      siteId: site.id,
      name: ADMINISTRATOR_ROLE,
    });
    const member = await manager.findOneBy(SiteMember, {
      siteId: site.id,
      userId,
    });
    if (!member) {
      await manager.save(
        manager.create(SiteMember, {
          siteId: site.id,
          userId,
          roleId: administrator.id,
        }),
      );
    } else if (member.roleId !== administrator.id) {
      await manager.update(
        SiteMember,
        { siteId: site.id, userId },
        { roleId: administrator.id },
      );
    }
    if (
      removePrevious &&
      previousOwnerId !== null &&
      previousOwnerId !== userId
    ) {
      await manager.delete(SiteMember, {
        siteId: site.id,
        userId: previousOwnerId,
      });
    }
  }
}
