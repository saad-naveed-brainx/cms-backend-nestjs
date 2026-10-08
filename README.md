# cms-api

NestJS + TypeORM API for the multi-tenant CMS. Owns the database and is the only
project that talks to Postgres. `cms-web` and `cms-admin` consume it over REST.

## Prerequisites

- Node 22 (`.nvmrc`)
- PostgreSQL 15+ — on this machine, the Homebrew server on `:5432` with a `cms`
  database already created

## Setup

```bash
npm install
cp .env.example .env        # then set DATABASE_URL to your user
npm run db:migrate          # create the tables
npm run dev                 # watch mode
```

`.env`:

```
DATABASE_URL="postgresql://<your-user>@localhost:5432/cms"
API_PORT=4001               # canonical port is 4000; Local (WP) holds it here
JWT_SECRET="dev-only-change-me"
CORS_ORIGINS="http://localhost:3000,http://localhost:5173"
```

`CORS_ORIGINS` must list the dev origins of `cms-web` (3000) and `cms-admin`
(5173) — they are separate origins, so CORS is what lets them call this API.

## Scripts

| Script                    | Does                                   |
| ------------------------- | -------------------------------------- |
| `npm run dev`             | `nest start --watch`                   |
| `npm run build`           | compile to `dist/`                     |
| `npm run start:prod`      | run the compiled build                 |
| `npm test` / `test:e2e`   | vitest unit / e2e (e2e needs a DB)     |
| `npm run lint`            | oxlint                                 |
| `npm run db:migrate`      | build, run pending migrations          |
| `npm run db:generate -- <path>` | build, generate a migration from entity changes |
| `npm run db:revert`       | build, undo the last migration         |
| `npm run db:show`         | list migrations and their state        |
| `npm run db:up`/`db:down` | Postgres via `docker-compose.yml`      |
| `npm run seed -- <flags>` | build, create a tenant and its first admin (`--organization --site --host --email --name`, password from `SEED_ADMIN_PASSWORD`) |

## Endpoints

- `GET /` — service name and version
- `GET /health` — status, database connectivity, uptime

## Notes

- TypeORM 1 with `pg`. Entities are in `src/database/entities/`, one per table, and
  the migration that creates them is in `src/database/migrations/`.
- `synchronize` is off: the schema only changes through migrations.
- The TypeORM CLI runs against the compiled `dist/` output, which is why every
  `db:*` script builds first.
- Only repositories may touch the database (`DataSource`, `Repository<T>`);
  tenant scoping is enforced there by design.
- `docker-compose.yml` maps host port **5433** so it cannot clash with a local
  Postgres on 5432. If you use it, set
  `DATABASE_URL="postgresql://cms:cms@localhost:5433/cms"`.
- Validation uses `zod` (installed); `class-validator` is deliberately absent.
