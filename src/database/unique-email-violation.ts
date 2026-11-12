import { QueryFailedError } from 'typeorm';

/** Postgres' code for a unique violation, and the name the migration gives the users' email rule. */
const UNIQUE_VIOLATION = '23505';
const USER_EMAIL_UNIQUE_CONSTRAINT = 'users_email_key';

/**
 * The users' unique email rule refused a new account: someone made it after the check. Shared by the
 * unscoped desks that create a user while accepting an invitation, so a rename of the rule is changed once.
 */
export function isUserEmailTaken(error: unknown): boolean {
  if (!(error instanceof QueryFailedError)) return false;
  const driverError = error.driverError as {
    code?: string;
    constraint?: string;
  };
  return (
    driverError.code === UNIQUE_VIOLATION &&
    driverError.constraint === USER_EMAIL_UNIQUE_CONSTRAINT
  );
}
