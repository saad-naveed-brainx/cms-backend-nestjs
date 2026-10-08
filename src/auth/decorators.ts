import {
  applyDecorators,
  createParamDecorator,
  SetMetadata,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';
import type { Permission } from './permission.js';

/** The signed-in user, put on the request by `JwtAuthGuard`. */
export type AuthUser = { id: string };

/** The site a request is about and what the user may do there, put on the request by `SiteAccessGuard`. */
export type SiteAccess = {
  siteId: string;
  roleId: string;
  roleName: string;
  permissions: Permission[];
};

/** A request after the two guards have run. A field is missing when its guard did not apply. */
export type AuthenticatedRequest = Request & {
  user?: AuthUser;
  site?: SiteAccess;
};

export const IS_PUBLIC = 'auth:public';
export const SITE_SCOPED = 'auth:site-scoped';
export const REQUIRED_PERMISSIONS = 'auth:permissions';

/** No token needed. Every route without this requires one (secure by default). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** The route is about one site: the `X-Site-Id` header is required, and the user must belong to that site. */
export const SiteScoped = () => SetMetadata(SITE_SCOPED, true);

/** Site-scoped, and the user's role on that site must hold all of these permissions. */
export const RequirePermission = (...permissions: Permission[]) =>
  applyDecorators(SiteScoped(), SetMetadata(REQUIRED_PERMISSIONS, permissions));

/** The signed-in user of this request. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthUser =>
    context.switchToHttp().getRequest<AuthenticatedRequest>().user!,
);

/** The site of this request, after the user's access to it was checked. */
export const CurrentSite = createParamDecorator(
  (_data: unknown, context: ExecutionContext): SiteAccess =>
    context.switchToHttp().getRequest<AuthenticatedRequest>().site!,
);
