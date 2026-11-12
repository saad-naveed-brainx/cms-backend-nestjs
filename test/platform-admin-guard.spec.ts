import {
  ForbiddenException,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
import type { PlatformRepository } from '../src/platform/platform.repository.js';
import { PlatformAdminGuard } from '../src/platform-admin/platform-admin.guard.js';

const contextFor = (user?: { id: string }) =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  }) as unknown as ExecutionContext;

/** A platform desk whose one answer a test can change between calls. */
function deskWith(row: { isPlatformAdmin: boolean } | null) {
  const state = { row };
  const desk = {
    findUserById: async () => state.row,
  } as unknown as PlatformRepository;
  return { state, guard: new PlatformAdminGuard(desk) };
}

describe('the platform admin guard', () => {
  it('[UC-PA-26] lets a super admin through', async () => {
    const { guard } = deskWith({ isPlatformAdmin: true });
    await expect(guard.canActivate(contextFor({ id: 'u1' }))).resolves.toBe(
      true,
    );
  });

  it('[UC-PA-26] refuses anyone else with a 403, an unknown account included', async () => {
    for (const row of [{ isPlatformAdmin: false }, null]) {
      const { guard } = deskWith(row);
      await expect(
        guard.canActivate(contextFor({ id: 'u1' })),
      ).rejects.toBeInstanceOf(ForbiddenException);
    }
  });

  it('[UC-PA-26] has no one to look at without a token check: 401', async () => {
    const { guard } = deskWith({ isPlatformAdmin: true });
    await expect(guard.canActivate(contextFor())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('[UC-PA-27] reads the flag on every request, so revoking works at once', async () => {
    const { state, guard } = deskWith({ isPlatformAdmin: true });
    await expect(guard.canActivate(contextFor({ id: 'u1' }))).resolves.toBe(
      true,
    );

    state.row = { isPlatformAdmin: false };

    await expect(
      guard.canActivate(contextFor({ id: 'u1' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
