import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HostnameRepository } from '../hostnames/hostname.repository.js';

/** How long the website is given to answer before the change is left to its own expiry. */
const TIMEOUT_MS = 3000;

/**
 * Tells the public website to forget what it remembers of a site (CNT-08, D-032). The website keeps
 * the API's answers for up to five minutes, one entry per site address and page; when a page is
 * published, unpublished, or changed while published, the site's entries must go at once, at every
 * address the site answers on, or visitors would see the old page.
 *
 * Off unless both `WEB_REVALIDATE_URL` (the website's `/api/revalidate`) and `REVALIDATE_SECRET` are
 * set. It never throws and never fails the change that called it: if the website cannot be reached,
 * the five-minute expiry is the safety net, and a warning is logged.
 */
@Injectable()
export class WebsiteCache {
  private readonly logger = new Logger(WebsiteCache.name);

  constructor(
    private readonly config: ConfigService,
    private readonly hostnames: HostnameRepository,
  ) {}

  async forgetSite(siteId: string): Promise<void> {
    const url = this.config.get<string>('WEB_REVALIDATE_URL');
    const secret = this.config.get<string>('REVALIDATE_SECRET');
    if (!url || !secret) return;

    const hosts = (await this.hostnames.findMany(siteId)).map(
      (row) => row.hostname,
    );
    if (hosts.length === 0) return;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${secret}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ hosts }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) {
        this.logger.warn(
          `The website answered ${response.status} when told to forget site ${siteId}; it expires on its own within five minutes`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Could not tell the website to forget site ${siteId} (${(error as Error).message}); it expires on its own within five minutes`,
      );
    }
  }
}
