import { createHmac } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SignJWT, jwtVerify } from 'jose';
import { readAuthConfig } from '../auth/auth-config.js';
import { isUuid } from '../database/scoped.repository.js';

/** How long a preview link works. Long enough to share a draft for review, short enough that a leaked link soon dies. */
export const PREVIEW_LIFETIME_SECONDS = 30 * 60;

/** Marks a token as a preview link, so nothing else is ever accepted as one. */
const AUDIENCE = 'cms-preview';

/**
 * Signs and checks preview links (feature site-preview, D-029): one page of one site, for 30
 * minutes. The key is derived from `JWT_SECRET` with its own label, so a preview link is never a
 * valid sign-in token and a sign-in token is never a valid preview link, even though both are
 * HS256. Stateless: a link cannot be withdrawn, only left to expire.
 */
@Injectable()
export class PreviewTokenService {
  private readonly key: Uint8Array;

  constructor(config: ConfigService) {
    const { secret } = readAuthConfig({
      JWT_SECRET: config.get<string>('JWT_SECRET'),
      JWT_EXPIRES_IN: config.get<string>('JWT_EXPIRES_IN'),
      NODE_ENV: config.get<string>('NODE_ENV'),
    });
    this.key = createHmac('sha256', secret)
      .update('cms-preview-link-v1')
      .digest();
  }

  /** A link for this page. `now` is for tests that need a link which has already run out. */
  async sign(
    siteId: string,
    pageId: string,
    now = Date.now(),
  ): Promise<{ token: string; expiresAt: Date }> {
    const issuedAt = Math.floor(now / 1000);
    const expiresAt = issuedAt + PREVIEW_LIFETIME_SECONDS;
    const token = await new SignJWT({ site: siteId })
      .setProtectedHeader({ alg: 'HS256' })
      .setAudience(AUDIENCE)
      .setSubject(pageId)
      .setIssuedAt(issuedAt)
      .setExpirationTime(expiresAt)
      .sign(this.key);
    return { token, expiresAt: new Date(expiresAt * 1000) };
  }

  /** The page and site a link names, or `null` for anything that is not a good, unexpired link of ours. Never throws. */
  async verify(
    token: unknown,
  ): Promise<{ siteId: string; pageId: string } | null> {
    if (typeof token !== 'string' || token.length === 0 || token.length > 2048)
      return null;
    try {
      const { payload } = await jwtVerify(token, this.key, {
        algorithms: ['HS256'],
        audience: AUDIENCE,
        requiredClaims: ['sub', 'exp', 'site'],
      });
      const siteId = payload.site;
      const pageId = payload.sub;
      return isUuid(siteId) && isUuid(pageId) ? { siteId, pageId } : null;
    } catch {
      return null;
    }
  }
}
