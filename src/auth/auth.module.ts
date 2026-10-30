import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { MembersModule } from '../members/members.module.js';
import { PlatformModule } from '../platform/platform.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { LOGIN_CLOCK, LoginAttempts } from './login-attempts.service.js';
import { PasswordService } from './password.service.js';
import { SignInPausedFilter } from './sign-in-paused.filter.js';
import { SiteAccessGuard } from './site-access.guard.js';
import { TokenService } from './token.service.js';

/**
 * Login, the sign-in limit, tokens and the two global guards. Registering the guards here makes
 * every route in the app closed unless it is marked `@Public()`. They run in the order they are
 * listed: the token check first, so the site check always has a user to look at.
 */
@Module({
  imports: [PlatformModule, MembersModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    LoginAttempts,
    { provide: LOGIN_CLOCK, useValue: () => Date.now() },
    PasswordService,
    TokenService,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: SiteAccessGuard },
    { provide: APP_FILTER, useClass: SignInPausedFilter },
  ],
  exports: [AuthService, PasswordService, TokenService],
})
export class AuthModule {}
