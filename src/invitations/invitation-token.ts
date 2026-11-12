import { createHash, randomBytes } from 'node:crypto';

/** How long a link works (plan D3): site invitations and owner invitations alike. */
export const INVITATION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

/** 32 random bytes as base64url (43 characters): the secret after `#` in the link (plan D4). */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/** What the database keeps instead of the secret (D-047): its SHA-256, in hex. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
