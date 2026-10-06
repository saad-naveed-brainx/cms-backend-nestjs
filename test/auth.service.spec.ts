import { randomUUID } from 'node:crypto';
import { AuthService } from '../src/auth/auth.service.js';
import type { PasswordService } from '../src/auth/password.service.js';
import { Permission } from '../src/auth/permission.js';
import type { TokenService } from '../src/auth/token.service.js';
import type { User } from '../src/database/entities/index.js';
import type { PlatformRepository } from '../src/platform/platform.repository.js';

/**
 * `AuthService` (FND-05) with fake collaborators: a platform desk over a handful of users, a
 * password checker that records what it was asked, and a token signer that does no signing. The
 * service under test is the real one. The fake desk matches an email exactly, so a login that
 * works with a messy address proves the service tidied it, not the desk.
 */

const PASSWORD = 'correct horse battery staple';
const EXPIRES_AT = new Date('2026-10-14T12:00:00.000Z');

type DeskMembership = {
  site: { id: string; name: string };
  role: { id: string; name: string; permissions: Permission[] };
};

/** A user as the desk hands it over: the whole row, stored hash included. */
function userRow(email: string, name: string): User {
  return {
    id: randomUUID(),
    email,
    name,
    passwordHash: `hash-of:${PASSWORD}`,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
  } as User;
}

function membership(
  siteName: string,
  roleName: string,
  permissions: Permission[],
): DeskMembership {
  return {
    site: { id: randomUUID(), name: siteName },
    role: { id: randomUUID(), name: roleName, permissions },
  };
}

/** What a client should be told about a desk membership: the permissions sit beside the role. */
function shown({ site, role }: DeskMembership) {
  return {
    site,
    role: { id: role.id, name: role.name },
    permissions: role.permissions,
  };
}

function setUp(
  users: User[],
  memberships: Record<string, DeskMembership[]> = {},
) {
  const desk = {
    findUserByEmail: async (email: string) =>
      users.find((user) => user.email === email) ?? null,
    findUserById: async (id: string) =>
      users.find((user) => user.id === id) ?? null,
    findMembershipsByUserId: async (id: string) => memberships[id] ?? [],
  };

  const passwordCalls: string[] = [];
  const passwords = {
    verify: async (plain: string, stored: string) => {
      passwordCalls.push('verify');
      return stored === `hash-of:${plain}`;
    },
    verifyAgainstDummy: async () => {
      passwordCalls.push('verifyAgainstDummy');
    },
  };

  const signedFor: string[] = [];
  const tokens = {
    sign: async (userId: string) => {
      signedFor.push(userId);
      return { token: `token-for-${userId}`, expiresAt: EXPIRES_AT };
    },
  };

  const service = new AuthService(
    desk as unknown as PlatformRepository,
    passwords as unknown as PasswordService,
    tokens as unknown as TokenService,
  );
  return { service, passwordCalls, signedFor };
}

describe('AuthService', () => {
  it('[UC-AU-06] an unknown email gets the dummy work and never a real password check', async () => {
    const { service, passwordCalls, signedFor } = setUp([]);

    const result = await service.login('ghost@nowhere.test', 'whatever');

    expect(result).toBeNull();
    // Once, and only the dummy: the time taken must not show that the email is unknown.
    expect(passwordCalls).toEqual(['verifyAgainstDummy']);
    expect(signedFor).toEqual([]);
  });

  it('[UC-AU-05] a wrong password for a real account is the same null, after a real check', async () => {
    const ayesha = userRow('ayesha@corrick.test', 'Ayesha');
    const { service, passwordCalls, signedFor } = setUp([ayesha]);

    const result = await service.login(
      'ayesha@corrick.test',
      'not the password',
    );

    expect(result).toBeNull();
    expect(passwordCalls).toEqual(['verify']);
    expect(signedFor).toEqual([]);
  });

  it('[UC-AU-01] [UC-AU-02] the right password gives a token and her profile, however the email is spelled', async () => {
    const ayesha = userRow('ayesha@corrick.test', 'Ayesha');
    const editor = membership('Corrick', 'Editor', [
      Permission.ContentCreate,
      Permission.ContentPublish,
    ]);
    const { service, passwordCalls, signedFor } = setUp([ayesha], {
      [ayesha.id]: [editor],
    });

    const result = await service.login(' Ayesha@Corrick.TEST ', PASSWORD);

    expect(result).toEqual({
      accessToken: `token-for-${ayesha.id}`,
      tokenType: 'Bearer',
      expiresAt: '2026-10-14T12:00:00.000Z',
      user: { id: ayesha.id, email: 'ayesha@corrick.test', name: 'Ayesha' },
      memberships: [shown(editor)],
    });
    expect(signedFor).toEqual([ayesha.id]);
    expect(passwordCalls).toEqual(['verify']);
    // Nothing of the stored hash reaches the caller.
    expect(JSON.stringify(result)).not.toContain('hash-of');

    // The password is not tidied the way the email is: one extra space and it is a different password.
    expect(
      await service.login('ayesha@corrick.test', `${PASSWORD} `),
    ).toBeNull();
    expect(
      await service.login('ayesha@corrick.test', ` ${PASSWORD}`),
    ).toBeNull();
  });

  it("[UC-AU-03] memberships keep each site's own role and permissions, and are empty for someone with none", async () => {
    const dana = userRow('dana@agency.test', 'Dana');
    const chen = userRow('chen@nowhere.test', 'Chen');
    const onBakery = membership('Bakery', 'Contributor', [
      Permission.ContentCreate,
    ]);
    const onCorrick = membership('Corrick', 'Admin', [
      Permission.ContentCreate,
      Permission.ContentPublish,
      Permission.SettingsManage,
    ]);
    const { service } = setUp([dana, chen], {
      [dana.id]: [onBakery, onCorrick],
    });

    const asDana = await service.login('dana@agency.test', PASSWORD);
    const asChen = await service.login('chen@nowhere.test', PASSWORD);

    // In the order the desk gave them, each with its own role and nothing from the other site.
    expect(asDana?.memberships).toEqual([shown(onBakery), shown(onCorrick)]);
    expect(asChen).not.toBeNull();
    expect(asChen?.memberships).toEqual([]);
  });

  it('[UC-AU-04] [UC-AU-09] the profile is read afresh on every call, and is null once the user is gone', async () => {
    const ayesha = userRow('ayesha@corrick.test', 'Ayesha');
    const users = [ayesha];
    const memberships: Record<string, DeskMembership[]> = {};
    const before = membership('Corrick', 'Editor', [Permission.ContentPublish]);
    memberships[ayesha.id] = [before];
    const { service } = setUp(users, memberships);

    expect(await service.profile(ayesha.id)).toEqual({
      user: { id: ayesha.id, email: 'ayesha@corrick.test', name: 'Ayesha' },
      memberships: [shown(before)],
    });

    // Her name and her role's permissions change; the next call shows both, nothing is remembered.
    ayesha.name = 'Ayesha Khan';
    const after = {
      ...before,
      role: {
        ...before.role,
        permissions: [Permission.ContentCreate, Permission.ContentDelete],
      },
    };
    memberships[ayesha.id] = [after];
    expect(await service.profile(ayesha.id)).toEqual({
      user: {
        id: ayesha.id,
        email: 'ayesha@corrick.test',
        name: 'Ayesha Khan',
      },
      memberships: [shown(after)],
    });

    // The account is deleted: there is no profile to give.
    users.length = 0;
    expect(await service.profile(ayesha.id)).toBeNull();
  });
});
