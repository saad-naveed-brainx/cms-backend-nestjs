import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import {
  HostnameTakenError,
  NotOrganizationOwnerError,
  OrganizationRequiredError,
  ProvisionInputError,
} from './tenant-input.js';

/**
 * The typed failures of creating a site or an organisation as the answers a client can act on.
 * Anything else stays a 500.
 */
export function toHttpError(error: unknown): unknown {
  if (error instanceof ProvisionInputError) {
    return new BadRequestException({
      message: 'Invalid request',
      errors: error.problems,
    });
  }
  if (error instanceof OrganizationRequiredError) {
    return new BadRequestException({
      message: 'Invalid request',
      errors: [`organizationId: ${error.message}`],
    });
  }
  if (error instanceof NotOrganizationOwnerError) {
    return new ForbiddenException(error.message);
  }
  if (error instanceof HostnameTakenError) {
    return new ConflictException(error.message);
  }
  return error;
}
