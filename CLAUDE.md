# cms-api — repo guide

Platform-wide guide and docs: **[../CLAUDE.md](../CLAUDE.md)** and **[../docs/](../docs/)**.
Read those first; this file covers only what is specific to this repo.

NestJS 12 + TypeORM 1 + PostgreSQL. **The only component with database access.** `web` and `admin`
reach it over REST.

## Invariants for this repo

1. Every content read/write goes through a repository, and every content method takes `siteId` as a
   **required** parameter. An unscoped method must not exist.
2. Nothing outside `src/**/*.repository.ts` imports `DataSource`, `EntityManager`, `Repository` or
   the default export from `typeorm`, a deep `typeorm/...` path, or anything from `@nestjs/typeorm`,
   except the health check, `database.module.ts`, `data-source.ts` and `test/**`. Lint-enforced by
   `.oxlintrc.json` (`no-restricted-imports`, B-12). Repositories inject `DataSource` and call
   `getRepository()`, with no `TypeOrmModule.forFeature` (`../docs/DECISIONS.md` D-015).
3. `synchronize` stays off. Every schema change is a migration.
4. HTML is sanitised **on write**. Never sanitise on read.
5. Validation is Zod. `class-validator` is deliberately not installed.
6. `siteId` comes from the authenticated request, never from a request body. `@CurrentSite()` is where
   this comes from: the `X-Site-Id` header, checked against membership on every request (decision D-018).
7. The two invariant tests (cross-tenant read denial, recursive path recomputation) must stay green.
   A red invariant test stops other work.

## Gotchas

- **Entities live in `src/database/entities/`** and are listed explicitly in `entities/index.ts`
  (`ENTITIES`). A new entity not added there is invisible to TypeORM.
- **The CLI runs on `dist/`.** `db:generate`, `db:migrate`, `db:revert` and `db:show` run
  `nest build` first, then use `dist/database/data-source.js`. No ts-node. That file loads `.env`
  with Node's `process.loadEnvFile()`; the app gets it from `@nestjs/config`.
- **TypeORM strips casts from defaults and treats `gen_random_uuid()` as generated** when it reads the
  schema back. Write `default: () => "'{}'"` (no `::jsonb`) and use `@PrimaryGeneratedColumn('uuid')`,
  or `db:generate` reports false changes. The app still assigns a v7 id in `@BeforeInsert`.
- **Drift check.** After migrating, `npm run db:generate -- src/database/migrations/Check` must
  print "No changes in database schema were found". If it generates a file, delete it and find out
  why.
- **No relation objects on entities.** Foreign keys are declared with `@ForeignKey` on plain id
  columns; same-site references are composite `(site_id, x_id)` keys. A composite key cannot use
  `ON DELETE SET NULL` (it would null `site_id` too), so those few links are plain keys and the API
  checks the site. See `../docs/DECISIONS.md` D-013.
- **Desks extend `ScopedRepository`**, so every method takes `siteId` first. `PlatformRepository` is
  the unscoped desk for reads: it extends nothing and reads across sites only by address or by user
  (host → site, email or id → user, user → their memberships, which also reads `site_members`, `roles` and each site's primary
  hostname and theme, which sign-in returns as `site.primaryHost` and `site.theme` (stored as is, `{}` for a new site) so the
  admin can link to the site and draw its live preview, and
  user → the organisations they own). A desk method that needs an
  all-or-nothing save opens its own transaction; no transaction object leaves the desk
  (`../docs/DECISIONS.md` D-015).
- **Creating a tenant** is `npm run seed -- --organization … --site … --host … --email … --name …`
  (`--host` repeats; the first is primary). The admin's password is only ever `SEED_ADMIN_PASSWORD`
  (12+ characters), never a flag; unset, a new user gets a generated one, printed once, and an
  existing email keeps theirs. It needs the API's `.env` (`DATABASE_URL`, `JWT_SECRET`).
  `ProvisioningRepository` is the second unscoped desk: writes, and only creates (`createTenant`, `createSite`),
  each in one transaction (`../docs/DECISIONS.md` D-019). A role's permission list is a snapshot: a permission
  added to `Permission` later reaches existing roles only through a migration.
- **Creating a site from the admin** is `POST /sites` (`name`, `hostnames`, and `organizationId` only when the person
  owns several organisations) and `GET /organizations` (the ones they own). Both need a sign-in and no `X-Site-Id`; only
  an organisation's owner may add a site to it (checked inside the transaction), and `createSite` shares its rows with
  `createTenant`, so a site made here and one made by the seed command are the same. It calls `invalidateSite` (below).
- **The public website reads `GET /public/site?host=&path=`** (`src/public/`, no token): the site comes from the host, the
  page is the published one at `path` (`/` is the page at `/home`), with the site's name and theme and a first
  navigation (published top-level Page-type pages except home, by title, at most 8). A draft, an unpublished page, a
  trashed page, an unknown path and another site's page are the same 404; nothing internal (ids) is in the answer; a
  bad `host` or `path` is a 400 before any query.
- **Preview links** (`src/preview/`, `../docs/DECISIONS.md` D-029): `POST /content/:id/preview` (any member, `X-Site-Id`)
  answers `{ token, expiresAt }`, a 30-minute HS256 token for one page of one site, signed with a key derived from
  `JWT_SECRET` and its own label, so it is never a sign-in token and a sign-in token is never a preview link. The
  website opens it with `GET /public/preview?host=&token=` (public, `Cache-Control: no-store`): the page as last
  saved, whatever its status, with `noIndex: true` and `preview.status`. A bad or expired token is a 401; a good one
  at another site's address, or for a trashed page, a 404. Stateless: a link cannot be withdrawn, only expire.
- **Code that changes a site's addresses, name, theme or settings must call `SiteResolver.invalidateSite(siteId)`**
  (`src/sites/`), or visitors can see the old data for up to 60 seconds. It also forgets remembered
  "unknown" addresses, so a newly added address works at once (no `invalidateHost` call needed). Hook
  shipped first, callers come later (`../docs/features/host-resolution/PLAN.md` D6,
  `../docs/DECISIONS.md` D-017).
- **Every route needs a token unless it is marked `@Public()`** (global guard, `src/auth/`). A site-scoped route
  (`@SiteScoped()`, `@RequirePermission(...)`) also needs the `X-Site-Id` header. Permissions are looked up per
  request, not read from the token. `JWT_SECRET` must be set (32+ characters in production); the test configs set
  their own, and `JWT_EXPIRES_IN` defaults to `7d` (`../docs/DECISIONS.md` D-018).
- **Pages routes** (`src/content/`): `GET` and `POST /content`, `GET` and `PATCH /content/:id`, `GET /content-types`, all with
  `X-Site-Id`. Reading is for any member, creating needs `content.create`, editing needs `content.edit_any` or `content.edit_own`
  on a page you created. A page's address is its type's prefix plus its slug, fixed at creation; slug and parent change
  only through their own tickets (CNT-04/05/06), and a body naming them or the status is a 400; the status changes
  through `POST /content/:id/publish` and `/unpublish` (`content.publish`). Lists page through `findPage` on the base
  desk. Block content is stored as sent and is **not sanitised until BLK-05**, so a `richText` block is refused (400) on create
  and edit until then; one a page already holds may stay exactly as it is (`../docs/DECISIONS.md` D-021).
- **ESM.** `"type": "module"` with `nodenext`: relative imports end in `.js`.
- **API tests (`test/*.e2e-spec.ts`) use `cms_test`** (the `DATABASE_URL` name + `_test`), set in
  `vitest.config.e2e.ts`. `test/support/` has `createTestApp`, `resetDatabase` (refuses non-`_test`
  databases) and `seedTwoSites`. Files run one at a time because they share that database.
- **`@nestjs/config` is `^12`** for Nest 12. The `^4` range belongs to Nest 10/11 and fails peer
  resolution.
- **Runs on port 4001 locally** (`API_PORT`), because Local (the WordPress tool) holds 4000.
- **Local database** is the Homebrew Postgres on `:5432`, database `cms`, connected as the OS user.
  `docker-compose.yml` is an alternative and maps host port **5433**.
- **`CORS_ORIGINS`** must list web (`:3000`) and admin (`:5173`), or neither can call this API.
- `npm audit` findings here are dev-only transitive deps — see `../docs/BACKLOG.md` B-08.

## Commands

```bash
npm run dev                                          # nest start --watch, port from API_PORT
npm run db:migrate                                   # build, then run pending migrations
npm run db:generate -- src/database/migrations/Name  # build, then diff entities vs database
npm run db:revert                                    # build, then undo the last migration
npm run db:show                                      # list migrations and whether each ran
npm test                                             # vitest
npm run test:e2e                                     # API tests on <db>_test, created + migrated automatically
```

`GET /` service info · `GET /health` status, database connectivity, uptime.
