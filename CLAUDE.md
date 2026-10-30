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
   this comes from: the `X-Site-Id` header, checked against membership on every request (decision D-018),
   and lower-cased by `SiteAccessGuard`, so an upper-case id is the same site and `site.siteId` is always the
   stored form (users-roles D11, B-24 (1)).
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
- **A new `permission` enum value needs its own migration, before any migration that uses it.** Postgres refuses a
  value in the transaction that added it ("unsafe use of new enum value"), so migrations run one transaction each
  (`migrationsTransactionMode: 'each'` in `data-source-options.ts`). A value cannot be dropped without rebuilding the type,
  so that migration's down leaves it.
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
  admin can link to the site and draw its live preview, and `ownsOrganization` (the user owns the site's organisation, so
  may delete it, D-039), and
  user → the organisations they own). The other unscoped desks are `ProvisioningRepository`, `SiteRemovalRepository`
  and `InvitationAcceptanceRepository` (below). A desk method that needs an
  all-or-nothing save opens its own transaction; no transaction object leaves the desk
  (`../docs/DECISIONS.md` D-015).
- **Creating a tenant** is `npm run seed -- --organization … --site … --host … --email … --name …`
  (`--host` repeats; the first is primary). The admin's password is only ever `SEED_ADMIN_PASSWORD`
  (12+ characters), never a flag; unset, a new user gets a generated one, printed once, and an
  existing email keeps theirs. It needs the API's `.env` (`DATABASE_URL`, `JWT_SECRET`).
  `ProvisioningRepository` is the second unscoped desk: writes, and only creates (`createTenant`, `createSite`),
  each in one transaction (`../docs/DECISIONS.md` D-019). Every site gets the five roles of `src/auth/roles.ts`
  (`ROLE_DEFINITIONS`: Administrator, Editor, Author, Contributor, Viewer), and its creator is the Administrator; sites made
  before that got the other four from the `AddFiveRoles` migration. A role's permission list is a snapshot: a permission
  added to `Permission` (or a change to `ROLE_DEFINITIONS`) reaches existing roles only through a migration, which copies
  the lists as literals.
- **The demo clients** are `npm run demo -- --email <account> [--domain <domain>] [--replace]` (`src/cli/run-demo.ts`,
  `demo/`, DEP-03 minimum, `../docs/DECISIONS.md` D-044): each folder in `demo/` (a `content.json` and `images/`) becomes an
  organisation and a site at `<address>.<domain>` (default `localhost`) owned by that account, through the same services the
  routes use (provisioning, invitations, media, appearance, content types, content, publish). `"picture:<file>"` in blocks
  becomes the picture's library address. `people` (`name`, `email`, `role`) join by invitation (users-roles D10): a new one's
  generated password is printed once; an email with an account keeps its password ("existing account, password unchanged")
  and joins through `InvitationAcceptanceRepository.accept`; `--email` may not be one of them. A page's `author` (a `people`
  email: the Editor or Author, not on Home) is created and published as them, with their role's real permissions. All of
  that is checked before anything is made. A client
  already there is refused unless `--replace` (deleted, then made again; accounts stay). It is its own process, so a running
  API's address memory may answer an old site for up to a minute after `--replace`.
- **Creating a site from the admin** is `POST /sites` (`name`, `hostnames`, and `organizationId` only when the person
  owns several organisations) and `GET /organizations` (the ones they own). Both need a sign-in and no `X-Site-Id`; only
  an organisation's owner may add a site to it (checked inside the transaction), and `createSite` shares its rows with
  `createTenant`, so a site made here and one made by the seed command are the same. It calls `invalidateSite` (below).
- **Deleting a site** is `DELETE /sites/:id` (`src/site-removal/`, `../docs/DECISIONS.md` D-039): signed in, no `X-Site-Id`; only the
  owner of the site's organisation (a member who is not is a 403, anyone else a 404). `SiteRemovalRepository` is the third
  unscoped desk and the only one that deletes a site: one transaction, the owner checked inside it, the site's row
  deleted so every site-owned row cascades. Then `invalidateSite` and `WebsiteCache.forgetHosts` with the addresses read
  before the delete (nothing remembers them afterwards).
- **Invitations** (`src/invitations/`, users-roles T3, plan D3/D5/D7, `../docs/DECISIONS.md` D-047/D-048/D-050):
  `POST /invitations` (`{ email, roleId }`), `POST /invitations/:id/renew` and `DELETE /invitations/:id`, all
  `members.manage` with `X-Site-Id`; `GET /members` also lists `invitations` (newest first, expired ones included, with
  `expired`). Making one for an email that already has a waiting invite on the site replaces it (new row, link, role,
  expiry); a member's email is a 409; a role not on the site a 400 (`roleId: …`). The link's secret (`token`, 32 random
  bytes as base64url) is answered once by create and renew and **never stored**: the table keeps `token_hash`, its SHA-256
  hex, so a database read hands out no working link; renew replaces it, so the old link stops working. `expires_at` is 7
  days on. Public: `POST /invitations/lookup` (`{ token }`) and `POST /invitations/accept` (`{ token, password, name? }`),
  which answers the login answer (`AuthService.signIn`). The email is always the invitation's and the site its row's.
  Whether the person has an account is decided at accept time: existing, the password goes through
  `AuthService.checkPassword` (sign-in's one check, which the sign-in limit wraps; a wrong one is a 401, or a 409 "This
  email already has an account. Sign in to join." when a `name` was sent); new, `name` 1–100 and `password` 12–256.
  Used, expired, cancelled and unknown links are the same 404. **`InvitationAcceptanceRepository` is the fourth unscoped
  desk** (D-048): two methods only, `findByTokenHash` and `accept`, one transaction that locks the invitation row
  (`FOR UPDATE`, so the second of two accepts finds it gone: 404), re-checks expiry, creates or checks the user, adds the
  membership unless already there, and deletes the invitation; a new account whose email was taken meanwhile rolls back
  (409, invite kept). Everything else goes through the scoped `InvitationRepository` (provided by `MembersModule`).
  Deleting a site deletes its invitations (FK cascade).
- **The media library** (`src/media/`, MED-01/02, `../docs/DECISIONS.md` D-042): `POST /media` (`media.upload`, `X-Site-Id`,
  multipart field `file`, at most 10 MB, else 413) and `GET /media?limit=&offset=` (any member, newest first). sharp decides
  what the file really is (JPEG, PNG or WebP only; anything else, an SVG or over 50 megapixels is a 400), turns it upright,
  scales it to 2400 pixels at most and writes it again, which drops the camera's details; a 480-pixel WebP `-thumb` sits
  beside it. Files are `MEDIA_DIR/<site id>/<uuid>.<ext>` (default `uploads/`, gitignored), served publicly by
  `GET /uploads/:siteId/:name` (only names the API writes; a year's `immutable` cache). The answer's `url`/`thumbUrl` are
  `MEDIA_PUBLIC_URL` plus the key (default `http://localhost:<API_PORT>/uploads`; live, the API's public address), and that
  full address is what blocks store. Deleting a site removes its folder. The API tests use their own `MEDIA_DIR`.
- **Making a content type** (`POST /content-types`, `content_types.manage`, `X-Site-Id`; `src/content/content-types.service.ts`,
  TYP-01 minimum, `../docs/DECISIONS.md` D-043): `{ name, urlPrefix }` only (`Recipe`, `/recipes`: one lower-case word or
  hyphenated words). The key is made from the name (`team-member`); a name or address another type has, or an address a
  page has, is a 409; `/api` and `/home` are kept for the website. No fields, editing or deleting. Nothing else is needed for
  it to work: items are made with `POST /content` (`type: 'recipe'`) at `/recipes/<slug>`, and the public route already
  lists any type with an address at that address and links it in the menu once something is published (CNT-13).
- **Every new site starts with a published Home page** (`../docs/DECISIONS.md` D-037): the Page at `/home` (what the
  website shows at `/`), whose only block is a hero with the site's name, written in the same transaction as the site's
  other rows. Tests that count rows or list a new site's pages see it; most public-site tests delete all content first.
- **The public website reads `GET /public/site?host=&path=&page=`** (`src/public/`, no token): the site comes from the host;
  the answer is the published page at `path` (`kind: 'page'`; `/` is the page at `/home`), with its search fields, or, at a type's own address with
  no page there (`/blog` for posts), that type's published items newest first, ten at a time (`kind: 'listing'`, `page`
  from 1, past the end a 404, a bad number a 400; `../docs/DECISIONS.md` D-031). Both carry the site's name and theme and a
  navigation: published top-level Page-type pages except home, by title, then a link to each blog page with something
  published (`Posts`), at most 8 with the blog links kept. A draft, an unpublished page, a
  trashed page, an unknown path and another site's page are the same 404; nothing internal (ids) is in the answer; a
  bad `host` or `path` is a 400 before any query.
- **Preview links** (`src/preview/`, `../docs/DECISIONS.md` D-029): `POST /content/:id/preview` (any member, `X-Site-Id`)
  answers `{ token, expiresAt }`, a 30-minute HS256 token for one page of one site, signed with a key derived from
  `JWT_SECRET` and its own label, so it is never a sign-in token and a sign-in token is never a preview link. The
  website opens it with `GET /public/preview?host=&token=` (public, `Cache-Control: no-store`): the page as last
  saved, whatever its status, with `noIndex: true` and `preview.status`. A bad or expired token is a 401; a good one
  at another site's address, or for a trashed page, a 404. Stateless: a link cannot be withdrawn, only expire.
- **The website caches the API's answers (CNT-08, `../docs/DECISIONS.md` D-032), so content changes must tell it.** Publish,
  unpublish and saving a published page call `WebsiteCache.forgetSite(siteId)` (`src/website/`), which POSTs the site's
  hostnames to `WEB_REVALIDATE_URL` with `REVALIDATE_SECRET`. Both unset: off. It never throws or fails the change; the
  website's five-minute expiry is the safety net. A new route that changes what a published page shows must call it too.
  The API tests run with it off (`vitest.config.e2e.ts`) unless a test points it at its own stand-in.
- **A site's appearance** (GOV-04, `src/appearance/`, `../docs/DECISIONS.md` D-036): `GET /appearance` (any member) and
  `PATCH /appearance` (`settings.manage`), both with `X-Site-Id`, read and save `{ name, tagline, footerNote, logoUrl, theme }`. The
  tagline, footer note and logo address (a full `http(s)://` address, normally a library picture, MED-03) live in
  `sites.settings` (other settings are kept; empty removes one; the public answer passes `settings` through); the theme is sent whole
  and checked against the website's own names and colour rule, mirrored by hand in `appearance-input.ts` (a choice added
  to `web/src/theme/theme.ts` must be added there). `SiteRepository` is the site's own row, keyed by the checked
  `siteId`, saved in one locked transaction. A save calls `invalidateSite` and `forgetSite`.
- **Code that changes a site's addresses, name, theme or settings must call `SiteResolver.invalidateSite(siteId)`**
  (`src/sites/`), or visitors can see the old data for up to 60 seconds. It also forgets remembered
  "unknown" addresses, so a newly added address works at once (no `invalidateHost` call needed). Hook
  shipped first, callers come later (`../docs/features/host-resolution/PLAN.md` D6,
  `../docs/DECISIONS.md` D-017).
- **Every route needs a token unless it is marked `@Public()`** (global guard, `src/auth/`). A site-scoped route
  (`@SiteScoped()`, `@RequirePermission(...)`) also needs the `X-Site-Id` header. Permissions are looked up per
  request, not read from the token. `JWT_SECRET` must be set (32+ characters in production); the test configs set
  their own, and `JWT_EXPIRES_IN` defaults to `7d` (`../docs/DECISIONS.md` D-018).
- **Members routes** (`src/members/`, users-roles T2, plan D6): `GET /members`, `PATCH /members/:userId` (`{ roleId }`) and
  `DELETE /members/:userId`, all `members.manage` with `X-Site-Id`. The list is `{ roles, members }`: roles in
  `ROLE_DEFINITIONS` order, members by name then id as `{ userId, name, email, role: { id, name }, isOwner }` (users read
  only through this site's `site_members` rows; never the password hash). A role not on this site is a 400, someone not a
  member (or a malformed id) a 404, the same role a no-op 200. "Administrator" means a role holding `members.manage`. Changes
  and removals run in ONE `SiteMemberRepository` transaction that locks the site's row first (`FOR UPDATE`, like site
  removal), so two Administrators acting at once are serialised: the organisation's owner may not lose `members.manage` or be
  removed (409 "The organisation's owner stays an Administrator.", checked first), and the last member holding it may not
  either (409 "A site needs at least one Administrator.").
- **Pages routes** (`src/content/`): `GET` and `POST /content`, `GET` and `PATCH /content/:id`, `GET` (and, above, `POST`) `/content-types`, all with
  `X-Site-Id`. Reading is for any member, creating needs `content.create`, editing needs `content.edit_any` or `content.edit_own`
  on a page you created. A page's address is its type's prefix plus its slug, fixed at creation; slug and parent change
  only through their own tickets (CNT-04/05/06), and a body naming them or the status is a 400; the status changes
  through `POST /content/:id/publish` and `/unpublish`: `content.publish` on any page, `content.publish_own` only on a page
  you created (Authors), else a 403 (a missing page is a 404 first). A page's search fields (SEO-01) are set on
  create and edit and come back with the page, not in list rows: `seoTitle` (up to 200 characters), `seoDescription` (500),
  `canonicalUrl` (a full `https://` or `http://` address, 2000) and `noIndex`; an empty text clears one. The share image
  (`ogImageId`) is refused until the media library. Lists page through `findPage` on the base
  desk; `GET /content` filters by `type`, `status` and `path` (one exact address, how the admin finds `/home`). Each list
  row carries `author: { id, name }` (the page's creator, `null` once their account is gone), read by joining `users` from
  this site's own content, so people removed from the site keep their name; never their email. Block content is stored as sent, except a text block (`richText`), whose HTML is **cleaned on save**
  (`src/content/clean-blocks.ts`, `sanitize-html`, BLK-05, `../docs/DECISIONS.md` D-041): paragraphs, line breaks, bold, italic,
  underline, strike, `h2`/`h3`, lists, quotes and `http(s)`/`mailto`/`tel`/on-site links survive, everything else is taken out
  keeping its words. The website draws stored HTML as it is (invariant 5), so nothing else may write a text block.
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
