import { Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import {
  Invitation,
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

/** A waiting invitation as the Users screen shows it. Never the token or its hash. */
export type InvitationView = {
  id: string;
  email: string;
  role: { id: string; name: string };
  /** ISO 8601. */
  expiresAt: string;
  expired: boolean;
  /** Who made it, `null` once their account is gone. */
  invitedBy: { id: string; name: string } | null;
  /** ISO 8601. */
  createdAt: string;
};

/** A new invitation: the email already trimmed and lower-cased, the secret already hashed. */
export type NewInvitation = {
  email: string;
  roleId: string;
  tokenHash: string;
  expiresAt: Date;
  invitedBy: string;
};

/** What making an invitation did, or why it was refused. */
export type InvitationCreation =
  | { outcome: 'created'; invitation: InvitationView }
  | { outcome: 'role-not-found' }
  | { outcome: 'already-member' };

/**
 * The invitations desk: one site's waiting invitations (users-roles plan D3, D5), `siteId` first
 * like every scoped desk. Finding an invitation by its link and accepting it happen before any
 * site is known, so they live on the separate `InvitationAcceptanceRepository`.
 */
@Injectable()
export class InvitationRepository extends ScopedRepository<Invitation> {
  constructor(private readonly dataSource: DataSource) {
    super(dataSource, Invitation);
  }

  /** The site's invitations, newest first, expired ones included. */
  async listForSite(siteId: string): Promise<InvitationView[]> {
    requireSiteId(siteId);
    return this.readViews(this.dataSource.manager, siteId);
  }

  /** One of the site's invitations, or `null` (unknown, malformed or another site's id). */
  async findView(siteId: string, id: string): Promise<InvitationView | null> {
    requireSiteId(siteId);
    if (!isUuid(id)) return null;
    const [view] = await this.readViews(this.dataSource.manager, siteId, id);
    return view ?? null;
  }

  /**
   * Makes an invitation for this email on this site, replacing a waiting one for the same email
   * (its link stops working; the new one is newer, with its own role, expiry and inviter). The
   * role must be one of this site's roles, and someone already a member is refused. The site's
   * row is locked first, so two invitations for one email at once cannot collide.
   */
  createOrReplace(
    siteId: string,
    data: NewInvitation,
  ): Promise<InvitationCreation> {
    requireSiteId(siteId);
    if (!isUuid(data.roleId)) {
      return Promise.resolve({ outcome: 'role-not-found' });
    }

    return this.dataSource.transaction(async (manager) => {
      // FOR NO KEY UPDATE, not FOR UPDATE: it still serialises two creates, but does not block the FOR KEY SHARE an accept's membership insert takes on the site (no deadlock).
      await manager.findOne(Site, {
        where: { id: siteId },
        lock: { mode: 'for_no_key_update' },
      });

      const role = await manager.existsBy(Role, { siteId, id: data.roleId });
      if (!role) return { outcome: 'role-not-found' };

      const member = await manager
        .createQueryBuilder(SiteMember, 'member')
        .innerJoin(User, 'person', 'person.id = member.userId')
        .where('member.siteId = :siteId', { siteId })
        .andWhere('person.email = :email', { email: data.email })
        .getExists();
      if (member) return { outcome: 'already-member' };

      await manager.delete(Invitation, { siteId, email: data.email });
      const saved = await manager.save(
        manager.create(Invitation, {
          siteId,
          email: data.email,
          roleId: data.roleId,
          tokenHash: data.tokenHash,
          expiresAt: data.expiresAt,
          invitedBy: data.invitedBy,
        }),
      );
      const [invitation] = await this.readViews(manager, siteId, saved.id);
      return { outcome: 'created', invitation };
    });
  }

  /**
   * Gives the invitation a new secret and a new expiry, so its old link stops working. `null`
   * when it is not one of this site's invitations.
   */
  async renew(
    siteId: string,
    id: string,
    tokenHash: string,
    expiresAt: Date,
  ): Promise<InvitationView | null> {
    const updated = await this.update(siteId, id, { tokenHash, expiresAt });
    return updated ? this.findView(siteId, id) : null;
  }

  /** Deletes the invitation, so its link stops working. `false` when it is not one of this site's. */
  async cancel(siteId: string, id: string): Promise<boolean> {
    requireSiteId(siteId);
    if (!isUuid(id)) return false;
    const { affected } = await this.dataSource
      .getRepository(Invitation)
      .delete({ siteId, id });
    return (affected ?? 0) > 0;
  }

  /**
   * The site's invitations (or the one named) with their role's name and their inviter's name.
   * The role is joined on `(site_id, role_id)`; the inviter is reached only through this site's
   * own invitations, and only their id and name are read.
   */
  private async readViews(
    manager: EntityManager,
    siteId: string,
    id?: string,
  ): Promise<InvitationView[]> {
    const query = manager
      .createQueryBuilder(Invitation, 'invitation')
      .innerJoin(
        Role,
        'role',
        'role.siteId = invitation.siteId AND role.id = invitation.roleId',
      )
      .leftJoin(User, 'inviter', 'inviter.id = invitation.invitedBy')
      .select('invitation.id', 'id')
      .addSelect('invitation.email', 'email')
      .addSelect('role.id', 'roleId')
      .addSelect('role.name', 'roleName')
      .addSelect('invitation.expiresAt', 'expiresAt')
      .addSelect('inviter.id', 'inviterId')
      .addSelect('inviter.name', 'inviterName')
      .addSelect('invitation.createdAt', 'createdAt')
      .where('invitation.siteId = :siteId', { siteId })
      .andWhere('role.siteId = :siteId', { siteId })
      .orderBy('invitation.createdAt', 'DESC')
      .addOrderBy('invitation.id', 'DESC');
    if (id) query.andWhere('invitation.id = :id', { id });

    const rows = await query.getRawMany<{
      id: string;
      email: string;
      roleId: string;
      roleName: string;
      expiresAt: Date;
      inviterId: string | null;
      inviterName: string | null;
      createdAt: Date;
    }>();
    const now = Date.now();
    return rows.map((row) => {
      const expiresAt = new Date(row.expiresAt);
      return {
        id: row.id,
        email: row.email,
        role: { id: row.roleId, name: row.roleName },
        expiresAt: expiresAt.toISOString(),
        expired: expiresAt.getTime() <= now,
        invitedBy:
          row.inviterId && row.inviterName !== null
            ? { id: row.inviterId, name: row.inviterName }
            : null,
        createdAt: new Date(row.createdAt).toISOString(),
      };
    });
  }
}
