import {
  Body,
  Controller,
  Delete,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';
import { z } from 'zod';
import type { LoginResult } from '../auth/auth.service.js';
import {
  CurrentSite,
  CurrentUser,
  Public,
  RequirePermission,
  type AuthUser,
  type SiteAccess,
} from '../auth/decorators.js';
import { Permission } from '../auth/permission.js';
import { parseOr400 } from '../content/content-input.js';
import {
  InvitationsService,
  type InvitationLookup,
  type IssuedInvitation,
} from './invitations.service.js';

/** The email is tidied (trimmed, lower-cased) and then checked, as at sign-in. */
const CreateBody = z.strictObject({
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  roleId: z.uuid(),
});

const LookupBody = z.object({ token: z.string() });

/**
 * Only the token and the password are checked here; which other rules apply (a new account's
 * name and longer password) depends on the invitation, so the service checks them. Anything
 * else in the body, an email included, is ignored: the email is the invitation's.
 */
const AcceptBody = z.object({
  token: z.string(),
  password: z.string().min(1).max(256),
  name: z.unknown().optional(),
});

/**
 * Invitations (users-roles T3). Making, renewing and cancelling need `members.manage` on the
 * site named by `X-Site-Id`; looking up and accepting are public (the link's secret is the
 * credential) and know no site until the invitation is read.
 */
@Controller('invitations')
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @Post()
  @RequirePermission(Permission.MembersManage)
  create(
    @CurrentSite() site: SiteAccess,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ): Promise<IssuedInvitation> {
    const { email, roleId } = parseOr400(CreateBody, body);
    return this.invitations.create(site.siteId, user.id, email, roleId);
  }

  @Public()
  @Post('lookup')
  @HttpCode(200)
  lookup(@Body() body: unknown): Promise<InvitationLookup> {
    const { token } = parseOr400(LookupBody, body);
    return this.invitations.lookup(token);
  }

  @Public()
  @Post('accept')
  @HttpCode(200)
  accept(@Body() body: unknown): Promise<LoginResult> {
    const { token, password, name } = parseOr400(AcceptBody, body);
    return this.invitations.accept(token, password, name);
  }

  @Post(':id/renew')
  @HttpCode(200)
  @RequirePermission(Permission.MembersManage)
  renew(
    @CurrentSite() site: SiteAccess,
    @Param('id') id: string,
  ): Promise<IssuedInvitation> {
    return this.invitations.renew(site.siteId, id);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission(Permission.MembersManage)
  async cancel(
    @CurrentSite() site: SiteAccess,
    @Param('id') id: string,
  ): Promise<void> {
    await this.invitations.cancel(site.siteId, id);
  }
}
