import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { isUuid } from '../database/scoped.repository.js';
import { SiteMemberRepository } from '../members/site-member.repository.js';
import {
  REQUIRED_PERMISSIONS,
  SITE_SCOPED,
  type AuthenticatedRequest,
} from './decorators.js';
import type { Permission } from './permission.js';

/**
 * The second global guard, for routes marked `@SiteScoped()` or `@RequirePermission(...)`: the
 * request names its site in the `X-Site-Id` header, and the user must belong to that site and hold
 * every permission the route asks for (D-018, `api/CLAUDE.md` rule 6).
 *
 * - The header must be exactly one uuid: missing, empty, repeated or malformed is a 400, decided
 *   before anything is read from the database.
 * - A site the user is not a member of and a site that does not exist are the same 403, so the
 *   answer does not say which site ids exist. A missing permission is that same 403.
 * - The role is read on every request, so a changed role or a removed member takes effect at once.
 * - A `siteId` in the body or query string is never looked at.
 */
@Injectable()
export class SiteAccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly members: SiteMemberRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    const siteScoped = this.reflector.getAllAndOverride<boolean | undefined>(
      SITE_SCOPED,
      targets,
    );
    if (!siteScoped) return true;
    const required =
      this.reflector.getAllAndOverride<Permission[] | undefined>(
        REQUIRED_PERMISSIONS,
        targets,
      ) ?? [];

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    // Only reachable when a route is both public and site-scoped: there is no one to check.
    if (!request.user) throw new UnauthorizedException();

    // A repeated header arrives joined with ", ", so it fails this check like any malformed one.
    const siteId = request.headers['x-site-id'];
    if (!isUuid(siteId)) {
      throw new BadRequestException(
        'X-Site-Id must be the id of one site (a uuid)',
      );
    }

    const access = await this.members.findAccess(siteId, request.user.id);
    if (
      !access ||
      !required.every((permission) => access.permissions.includes(permission))
    ) {
      throw new ForbiddenException();
    }

    request.site = { siteId, ...access };
    return true;
  }
}
