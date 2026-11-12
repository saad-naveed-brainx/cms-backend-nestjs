import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/decorators.js';
import { PlatformRepository } from '../platform/platform.repository.js';

/**
 * Puts a route behind "is this person a super admin?" (platform-admin D2, D-062). Use it as
 * `@UseGuards(PlatformAdminGuard)` on a controller; the token check (`JwtAuthGuard`) has already run.
 *
 * The flag is read from the database on every request, never from the token, so taking it away
 * (`create-super-admin --revoke`) works at once. Anyone else, an unknown account included, is a 403.
 */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  constructor(private readonly platform: PlatformRepository) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.user) throw new UnauthorizedException();
    const user = await this.platform.findUserById(request.user.id);
    if (!user?.isPlatformAdmin) {
      throw new ForbiddenException(
        'Only the platform administrator may do this',
      );
    }
    return true;
  }
}
