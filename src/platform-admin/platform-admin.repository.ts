import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { User } from '../database/entities/index.js';

/** What `grantPlatformAdmin` did for an email. */
export type GrantedPlatformAdmin = {
  id: string;
  email: string;
  /** `true` when the account was made by this call; `false` when it already existed. */
  created: boolean;
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
}
