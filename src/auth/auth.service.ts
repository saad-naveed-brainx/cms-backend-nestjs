import { Injectable } from '@nestjs/common';
import { PlatformRepository } from '../platform/platform.repository.js';
import { PasswordService } from './password.service.js';
import type { Permission } from './permission.js';
import { TokenService } from './token.service.js';

/** One site the user belongs to, with their role there and what that role allows. */
export type Membership = {
  site: { id: string; name: string };
  role: { id: string; name: string };
  permissions: Permission[];
};

type PublicUser = { id: string; email: string; name: string };

/** What `/auth/me` answers: who the token belongs to, as the database has it now. */
export type Profile = { user: PublicUser; memberships: Membership[] };

export type LoginResult = {
  accessToken: string;
  tokenType: 'Bearer';
  /** ISO 8601. */
  expiresAt: string;
  user: PublicUser;
  memberships: Membership[];
};

/**
 * Login, and "who am I" for a token already issued. Wrong credentials are `null`, not an error: the
 * caller answers 401 with one message for both an unknown email and a wrong password, so nothing
 * says which emails have accounts (docs/DECISIONS.md D-018).
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly platform: PlatformRepository,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
  ) {}

  /** `email` is already known to be an email. It is trimmed and lower-cased here, the password never. */
  async login(email: string, password: string): Promise<LoginResult | null> {
    const user = await this.platform.findUserByEmail(
      email.trim().toLowerCase(),
    );
    if (!user) {
      // Same work as a wrong password, so the time taken does not say the email is unknown.
      await this.passwords.verifyAgainstDummy(password);
      return null;
    }
    if (!(await this.passwords.verify(password, user.passwordHash))) {
      return null;
    }

    const memberships = await this.memberships(user.id);
    const { token, expiresAt } = await this.tokens.sign(user.id);
    return {
      accessToken: token,
      tokenType: 'Bearer',
      expiresAt: expiresAt.toISOString(),
      user: toPublicUser(user),
      memberships,
    };
  }

  /** The user's current details and memberships, or `null` when the user no longer exists. */
  async profile(userId: string): Promise<Profile | null> {
    const user = await this.platform.findUserById(userId);
    if (!user) return null;
    return {
      user: toPublicUser(user),
      memberships: await this.memberships(user.id),
    };
  }

  private async memberships(userId: string): Promise<Membership[]> {
    const rows = await this.platform.findMembershipsByUserId(userId);
    return rows.map(({ site, role }) => ({
      site,
      role: { id: role.id, name: role.name },
      permissions: role.permissions,
    }));
  }
}

/** Only these three fields ever leave the API: never the password hash. */
function toPublicUser(user: {
  id: string;
  email: string;
  name: string;
}): PublicUser {
  return { id: user.id, email: user.email, name: user.name };
}
