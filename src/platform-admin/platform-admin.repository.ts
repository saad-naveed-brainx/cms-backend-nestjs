import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  Organization,
  OrganizationInvitation,
  User,
} from '../database/entities/index.js';

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

/**
 * The platform-admin desk (platform-admin plan D3, D-062): the third place allowed to read across
 * organisations, after the platform desk and the site-removal desk. It covers `users`, `organizations`
 * and `organization_invitations` only; whatever a website owns is reached through that website's scoped
 * desks, one `siteId` at a time. `test/platform-admin-repository.spec.ts` pins its method list: a new
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
}
