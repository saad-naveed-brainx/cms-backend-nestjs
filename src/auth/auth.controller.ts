import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { z } from 'zod';
import {
  AuthService,
  type LoginResult,
  type Membership,
} from './auth.service.js';
import { CurrentUser, Public, type AuthUser } from './decorators.js';

/**
 * The email is tidied (trimmed, lower-cased) and then checked, at most 254 characters. The
 * password is checked as it is and never trimmed: spaces are part of it. At most 256 characters,
 * so a huge password cannot make the hashing expensive.
 */
const LoginBody = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  password: z.string().min(1).max(256),
});

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /**
   * Public. Wrong credentials are always the same 401 message, an unknown email included. A body
   * that is not an email and a password is a 400, decided before any database call.
   */
  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body() body: unknown): Promise<LoginResult> {
    const credentials = LoginBody.safeParse(body);
    if (!credentials.success) {
      throw new BadRequestException('An email and a password are required');
    }

    const result = await this.auth.login(
      credentials.data.email,
      credentials.data.password,
    );
    if (!result) throw new UnauthorizedException('Invalid email or password');
    return result;
  }

  /**
   * Who the token belongs to, read fresh from the database (name, memberships, permissions as they
   * are now). A token for a user who no longer exists is a 401.
   */
  @Get('me')
  async me(@CurrentUser() current: AuthUser): Promise<{
    user: { id: string; email: string; name: string };
    memberships: Membership[];
  }> {
    const profile = await this.auth.profile(current.id);
    if (!profile) throw new UnauthorizedException();
    return profile;
  }
}
