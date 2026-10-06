import { Injectable } from '@nestjs/common';
import { DataSource, type Repository } from 'typeorm';
import { Hostname, Site, User } from '../database/entities/index.js';

/**
 * The platform desk: the ONE desk allowed to read across sites, and the only repository that does
 * not extend `ScopedRepository`.
 *
 * It exists because two questions are asked before any site is known: which site answers on this
 * web address, and which user has this email (to log in). Neither has a `siteId` to start from, so
 * neither can go through a scoped desk. The alternative, an unscoped escape hatch on every desk,
 * would make every call site a place to forget the site. So these exceptions live here, in one
 * place a reviewer can see at once (invariant 1; docs/DECISIONS.md D-015; brief decision Q3).
 *
 * Kept narrow on purpose:
 * - It covers `sites`, `hostnames` and `users` only: the shared tables. Whatever a site owns
 *   (pages, media, menus, ...) stays behind the scoped desks.
 * - It has exactly two methods, because a third would be a third unscoped query.
 *   test/platform-repository.spec.ts pins the list, private methods included: a helper belongs in
 *   a plain function outside this class, not on it.
 * - Each lookup lower-cases its input and does nothing else: no trimming, no port stripping, no
 *   `www.` fallback. The tables store lower case, and tidying a raw Host header is FND-04's job.
 *   The match is exact, never a pattern, and values are always bound parameters.
 * - It holds no state between calls. FND-04 adds the host-to-site cache, outside this class.
 */
@Injectable()
export class PlatformRepository {
  private readonly sites: Repository<Site>;
  private readonly users: Repository<User>;

  constructor(dataSource: DataSource) {
    this.sites = dataSource.getRepository(Site);
    this.users = dataSource.getRepository(User);
  }

  /**
   * The site that answers on this web address, whether it is the site's primary address or one of
   * its others, with its whole row (theme and settings included). `null` when none does.
   */
  async findSiteByHostname(hostname: string): Promise<Site | null> {
    return this.sites
      .createQueryBuilder('site')
      .innerJoin(Hostname, 'hostname', 'hostname.siteId = site.id')
      .where('hostname.hostname = :hostname', {
        hostname: hostname.toLowerCase(),
      })
      .getOne();
  }

  /**
   * The user with this email, with their whole row: the stored password hash is included, because
   * the login step needs it. `null` when no user has it.
   */
  async findUserByEmail(email: string): Promise<User | null> {
    return this.users.findOneBy({ email: email.toLowerCase() });
  }
}
