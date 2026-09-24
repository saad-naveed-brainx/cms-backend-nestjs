# cms-api

NestJS + Prisma API for the multi-tenant CMS. Owns the database and is the only
project that talks to Postgres. `cms-web` and `cms-admin` consume it over REST.

## Prerequisites

- Node 22 (`.nvmrc`)
- PostgreSQL 15+ — on this machine, the Homebrew server on `:5432` with a `cms`
  database already created

## Setup

```bash
npm install                 # postinstall runs `prisma generate`
cp .env.example .env        # then set DATABASE_URL to your user
npm run dev                 # watch mode
```

`.env`:

```
DATABASE_URL="postgresql://<your-user>@localhost:5432/cms?schema=public"
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
| `npm run db:migrate`      | `prisma migrate dev`                   |
| `npm run db:studio`       | Prisma Studio                          |
| `npm run prisma:generate` | regenerate the Prisma client           |
| `npm run db:up`/`db:down` | Postgres via `docker-compose.yml`      |

## Endpoints

- `GET /` — service name and version
- `GET /health` — status, database connectivity, uptime

## Notes

- Prisma 7 connects through a **driver adapter**, not a bundled engine.
  `PrismaService` builds a `PrismaPg` adapter from `DATABASE_URL`.
- The client generates as TypeScript into `src/generated/prisma` and is
  gitignored; `postinstall` regenerates it after a fresh clone.
- `prisma/schema.prisma` holds only the datasource and generator — no models
  yet. Datasource URL is wired in `prisma7.config.ts`.
- `PrismaModule` is `@Global`. Direct `PrismaService` use outside the repository
  layer is discouraged: tenant scoping is enforced there by design.
- `docker-compose.yml` maps host port **5433** so it cannot clash with a local
  Postgres on 5432. If you use it, set
  `DATABASE_URL="postgresql://cms:cms@localhost:5433/cms?schema=public"`.
- Validation uses `zod` (installed); `class-validator` is deliberately absent.
- `.agents/` holds Prisma's own agent skill docs, added by `prisma init`. Safe
  to delete.
