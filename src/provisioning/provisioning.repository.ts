import { Injectable } from '@nestjs/common';
import { DataSource, QueryFailedError, type EntityManager } from 'typeorm';
import { ADMINISTRATOR_ROLE, ROLE_DEFINITIONS } from '../auth/roles.js';
import { ContentStatus } from '../database/entities/content.entity.js';
import {
  Content,
  ContentType,
  Hostname,
  Organization,
  Role,
  Site,
  SiteMember,
  User,
} from '../database/entities/index.js';
import { HOME_PATH } from '../public/public-path.js';
import {
  HostnameTakenError,
  NotOrganizationOwnerError,
} from './tenant-input.js';

/** Everything needed to create a tenant. The addresses are already tidied, and the first is primary. */
export type NewTenant = {
  organizationName: string;
  siteName: string;
  hostnames: string[];
  /** `passwordHash: null` means the user already exists and is looked up by `email`. */
  admin: { email: string; name: string; passwordHash: string | null };
};

/** A site to add to an organisation that already exists, for the person who owns it. */
export type NewSite = {
  organizationId: string;
  siteName: string;
  /** Already tidied, de-duplicated, at least one; the first is primary. */
  hostnames: string[];
  userId: string;
};

export type CreatedSite = { siteId: string; roleId: string };

export type CreatedTenant = {
  organizationId: string;
  siteId: string;
  userId: string;
  userCreated: boolean;
  roleId: string;
};

/** Re-exported so existing imports keep working; the roles themselves live in `auth/roles.ts`. */
export { ADMINISTRATOR_ROLE };

/** The two content types every site is born with (the brief's built-in Page and Post). */
const BUILT_IN_CONTENT_TYPES = [
  {
    slug: 'page',
    name: 'Page',
    urlPrefix: null,
    hierarchical: true,
    hasCategories: false,
    hasTags: false,
  },
  {
    slug: 'post',
    name: 'Post',
    urlPrefix: '/blog',
    hierarchical: false,
    hasCategories: true,
    hasTags: true,
  },
];

/** The site's front page (D-037): the Page at `/home`, as the website shows it at `/`. */
const HOME_PAGE = { title: 'Home', slug: 'home', path: HOME_PATH };

/** Postgres' code for a unique violation, and the name the migration gives the address rule. */
const UNIQUE_VIOLATION = '23505';
const ADDRESS_UNIQUE_CONSTRAINT = 'hostnames_hostname_key';

/**
 * The provisioning desk: the SECOND unscoped desk, next to the platform desk, and the ONLY place
 * that creates a tenant.
 *
 * It exists because a tenant is built before there is a site to scope to. It inserts rows no site
 * owns yet (the user, the organisation, the site itself) and then the site's own rows (addresses,
 * roles, membership, content types, the Home page), and all of it must succeed or fail together. A
 * scoped desk needs a `siteId` that does not exist yet, and no transaction object leaves a desk, so
 * several desks cannot share one transaction (docs/DECISIONS.md D-015, D-019).
 *
 * Kept narrow on purpose:
 * - It only creates. It reads nothing for anyone else, updates nothing and deletes nothing, and
 *   `createTenant` and `createSite` are its only methods: a helper belongs in a plain function
 *   outside this class.
 * - Every site-owned row it writes carries the id of the site it has just created, never one
 *   passed in, so it cannot write into an existing tenant (invariant 1).
 * - Nothing else may use it: tenants and sites are created through `ProvisioningService`.
 */
@Injectable()
export class ProvisioningRepository {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Creates the user (or finds the existing one), the organisation they own, a site in it, its
   * addresses, its five roles (`auth/roles.ts`), the user's membership as Administrator, and
   * the Page and Post content types and the published Home page, in one transaction: any failure
   * undoes all of it.
   *
   * An address another site already holds is a `HostnameTakenError` naming it. Any other error
   * propagates as it is.
   */
  async createTenant(data: NewTenant): Promise<CreatedTenant> {
    return this.dataSource.transaction(async (manager) => {
      const { user, userCreated } = await saveOrFindAdmin(manager, data.admin);

      const organization = await manager.save(
        manager.create(Organization, {
          name: data.organizationName,
          ownerId: user.id,
        }),
      );
      const { siteId, roleId } = await createSiteRows(manager, {
        organizationId: organization.id,
        siteName: data.siteName,
        hostnames: data.hostnames,
        userId: user.id,
      });

      return {
        organizationId: organization.id,
        siteId,
        userId: user.id,
        userCreated,
        roleId,
      };
    });
  }

  /**
   * Adds a site to an organisation the person owns: the site, its addresses, its five roles, the
   * person's membership as Administrator, the Page and Post content types
   * and the published Home page, in one transaction. Ownership is checked inside the transaction,
   * so a site can never be added to someone else's organisation, even by a caller's mistake
   * (`NotOrganizationOwnerError`).
   * An address another site already holds is a `HostnameTakenError` naming it. Every error undoes
   * all of it.
   */
  async createSite(data: NewSite): Promise<CreatedSite> {
    return this.dataSource.transaction(async (manager) => {
      const owned = await manager.findOneBy(Organization, {
        id: data.organizationId,
        ownerId: data.userId,
      });
      if (!owned) throw new NotOrganizationOwnerError();
      return createSiteRows(manager, data);
    });
  }
}

/**
 * The rows every new site starts with, written inside the caller's transaction: the site (empty
 * theme and settings), its addresses (the first primary), the five roles of `ROLE_DEFINITIONS`,
 * the person's membership as Administrator, the built-in content types, and a published
 * Home page whose only block is a hero with the site's name, so the site's `/` is never empty
 * (D-037). Every site-owned row carries the id of the site just created.
 */
async function createSiteRows(
  manager: EntityManager,
  data: {
    organizationId: string;
    siteName: string;
    hostnames: string[];
    userId: string;
  },
): Promise<CreatedSite> {
  const site = await manager.save(
    manager.create(Site, {
      organizationId: data.organizationId,
      name: data.siteName,
      theme: {},
      settings: {},
    }),
  );

  await saveAddresses(manager, site.id, data.hostnames);

  let administrator: Role | undefined;
  for (const definition of ROLE_DEFINITIONS) {
    const role = await manager.save(
      manager.create(Role, {
        siteId: site.id,
        name: definition.name,
        permissions: [...definition.permissions],
      }),
    );
    if (definition.name === ADMINISTRATOR_ROLE) administrator = role;
  }
  const role = administrator!;
  await manager.save(
    manager.create(SiteMember, {
      siteId: site.id,
      userId: data.userId,
      roleId: role.id,
    }),
  );

  const types: ContentType[] = [];
  for (const definition of BUILT_IN_CONTENT_TYPES) {
    types.push(
      await manager.save(
        manager.create(ContentType, {
          ...definition,
          siteId: site.id,
          fields: [],
          isBuiltin: true,
        }),
      ),
    );
  }

  const pageType = types.find((type) => type.slug === 'page')!;
  await manager.save(
    manager.create(Content, {
      ...HOME_PAGE,
      siteId: site.id,
      contentTypeId: pageType.id,
      parentId: null,
      status: ContentStatus.Published,
      publishedAt: new Date(),
      blocks: [{ type: 'hero', headline: data.siteName }],
      data: {},
      createdBy: data.userId,
      updatedBy: data.userId,
    }),
  );

  return { siteId: site.id, roleId: role.id };
}

/** A new user when a hash is given, otherwise the existing user with that email (or an error). */
async function saveOrFindAdmin(
  manager: EntityManager,
  admin: NewTenant['admin'],
): Promise<{ user: User; userCreated: boolean }> {
  if (admin.passwordHash !== null) {
    const user = await manager.save(
      manager.create(User, {
        email: admin.email,
        name: admin.name,
        passwordHash: admin.passwordHash,
      }),
    );
    return { user, userCreated: true };
  }

  const user = await manager.findOneBy(User, { email: admin.email });
  if (!user) {
    throw new Error(
      `No user with the email "${admin.email}" exists to administer the new site`,
    );
  }
  return { user, userCreated: false };
}

/**
 * One insert per address, in order, so that a clash names the address that caused it and so
 * that the first one (primary) is stored first.
 */
async function saveAddresses(
  manager: EntityManager,
  siteId: string,
  hostnames: string[],
): Promise<void> {
  for (const [index, hostname] of hostnames.entries()) {
    try {
      await manager.save(
        manager.create(Hostname, { siteId, hostname, isPrimary: index === 0 }),
      );
    } catch (error) {
      throw isAddressTaken(error) ? new HostnameTakenError(hostname) : error;
    }
  }
}

function isAddressTaken(error: unknown): boolean {
  if (!(error instanceof QueryFailedError)) return false;
  const { code, constraint } = error.driverError as {
    code?: string;
    constraint?: string;
  };
  return code === UNIQUE_VIOLATION && constraint === ADDRESS_UNIQUE_CONSTRAINT;
}
