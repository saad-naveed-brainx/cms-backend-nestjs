import {
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC, type AuthenticatedRequest } from './decorators.js';
import { TokenService } from './token.service.js';

/** The token in `Authorization: Bearer <token>`. The scheme's case does not matter. */
function bearerToken(header: string | undefined): string | null {
  return header?.match(/^bearer +(\S+)$/i)?.[1] ?? null;
}

/**
 * The first of the two global guards: every route needs a valid token unless it is marked
 * `@Public()`, so a route someone forgot to think about is closed, not open (D-018).
 *
 * Every failure is the same 401, whatever was wrong with the token. Nothing here reads the database:
 * the token is checked by its signature alone.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(
      IS_PUBLIC,
      [context.getHandler(), context.getClass()],
    );
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = bearerToken(request.headers.authorization);
    const verified = token ? await this.tokens.verify(token) : null;
    if (!verified) throw new UnauthorizedException();

    request.user = { id: verified.userId };
    return true;
  }
}
