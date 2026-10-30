import {
  Catch,
  HttpException,
  HttpStatus,
  type ArgumentsHost,
} from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import type { Response } from 'express';

/** The answer while an email's sign-in is paused (plan D8): a 429 that says when to try again. */
export class SignInPaused extends HttpException {
  constructor(readonly retryAfterSeconds: number) {
    const minutes = Math.ceil(retryAfterSeconds / 60);
    const unit = minutes === 1 ? 'minute' : 'minutes';
    super(
      HttpException.createBody(
        `Too many sign-in attempts. Try again in ${minutes} ${unit}.`,
        'Too Many Requests',
        HttpStatus.TOO_MANY_REQUESTS,
      ),
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

/**
 * Adds `Retry-After` to a `SignInPaused`, and otherwise answers as for any other error. A global
 * filter, so every route that checks a password gets the header without knowing about it.
 */
@Catch(SignInPaused)
export class SignInPausedFilter extends BaseExceptionFilter {
  catch(exception: SignInPaused, host: ArgumentsHost): void {
    host
      .switchToHttp()
      .getResponse<Response>()
      .setHeader('Retry-After', String(exception.retryAfterSeconds));
    super.catch(exception, host);
  }
}
