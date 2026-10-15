# Deploying NodePress

The runbook for the server team: the whole platform (this API, the website and the admin) on one
server at `nodepress.brainxdemo.com`. Every step runs on the server; the apps are the same code as
on a developer's machine, and only their settings differ. Project decision: D-045.

## What runs where

| Address | What answers | Runs as | Port inside the server |
| ------- | ------------ | ------- | ---------------------- |
| `api.nodepress.brainxdemo.com` | the API (this repo) | pm2 `nodepress-api` | 4000 |
| `*.nodepress.brainxdemo.com` | every client site (the `web` repo) | pm2 `nodepress-web` | 3000 |
| `admin.nodepress.brainxdemo.com` | the admin (the `admin` repo), static files | nginx | none |
| `nodepress.brainxdemo.com` | a redirect to the admin | nginx | none |

PostgreSQL on the same server, port 5432. If port 4000 or 3000 is taken, choose others and change
them together: 4000 is in this repo's `.env` (`API_PORT`), the website's `.env`
(`NEXT_PUBLIC_API_URL`) and this repo's `deploy/nginx.conf`; 3000 is in this repo's `.env`
(`WEB_REVALIDATE_URL`) and the website's `deploy/pm2.config.cjs` and `deploy/nginx.conf`.

## What the server needs

- **Node 22** (each repo's `.nvmrc`) with npm 10 or newer, and **pm2** (or your own process manager:
  the two commands it runs are in each repo's `deploy/pm2.config.cjs`).
- **PostgreSQL 13 or newer** (built and tested on 15).
- **nginx**, and **certbot** with its Cloudflare DNS plugin.
- **DNS**, in Cloudflare: one record, type `A`, name `*.nodepress`, the server's public IP,
  **DNS only** (grey cloud). It covers `admin.`, `api.` and every client site, present and future.
  Leave `nodepress.brainxdemo.com` itself as it is.

The steps below use `/srv/nodepress` for the code and `/srv/nodepress/uploads` for pictures. Any
other place works; change `MEDIA_DIR` and the admin's `root` in its `deploy/nginx.conf` to match.

## 1. Database

```sql
CREATE ROLE nodepress LOGIN PASSWORD '<a password>';
CREATE DATABASE nodepress OWNER nodepress;
```

The `nodepress` role must **own** the database: on its first connection the API switches on the
`uuid-ossp` extension, which PostgreSQL 13+ allows a database's owner to do without being a superuser.

## 2. Code

```bash
mkdir -p /srv/nodepress/uploads && cd /srv/nodepress
git clone git@github.com:saad-naveed-brainx/cms-backend-nestjs.git api
git clone git@github.com:saad-naveed-brainx/cms-frontend-web-nextjs.git web
git clone git@github.com:saad-naveed-brainx/cms-frontend-admin-react.git admin
```

## 3. The API

```bash
cd /srv/nodepress/api
cp deploy/production.env.example .env   # then fill the <…> values: the database password and two secrets
npm ci
npm run db:migrate                      # builds, then creates the tables
pm2 start deploy/pm2.config.cjs
curl http://127.0.0.1:4000/health       # {"status":"ok","database":"up","uptime":…}
```

## 4. The website

```bash
cd /srv/nodepress/web
cp deploy/production.env.example .env   # REVALIDATE_SECRET: the same value as in the API's .env
npm ci
npm run build                           # the API address is built in: a change to .env needs a new build
pm2 start deploy/pm2.config.cjs
```

## 5. The admin

```bash
cd /srv/nodepress/admin
cp deploy/production.env.example .env   # nothing to fill for nodepress.brainxdemo.com
npm ci
npm run build                           # writes dist/, which nginx serves; .env is built in too
```

## 6. The HTTPS certificate

One free Let's Encrypt certificate for `nodepress.brainxdemo.com` and `*.nodepress.brainxdemo.com`.
A wildcard can only be proved through DNS, so certbot needs a Cloudflare API token: in Cloudflare,
My Profile → API Tokens → Create Token → template **Edit zone DNS** → Zone Resources: Include,
Specific zone, `brainxdemo.com`. Keep the token out of chat, tickets and repositories.

```bash
sudo apt install certbot python3-certbot-dns-cloudflare
sudo mkdir -p /root/.secrets
sudo install -m 600 /dev/null /root/.secrets/cloudflare.ini
sudo nano /root/.secrets/cloudflare.ini   # one line: dns_cloudflare_api_token = <the token>
sudo certbot certonly --dns-cloudflare \
  --dns-cloudflare-credentials /root/.secrets/cloudflare.ini \
  -d nodepress.brainxdemo.com -d '*.nodepress.brainxdemo.com' \
  --deploy-hook 'systemctl reload nginx'
```

certbot renews it by itself before it expires (every 60 days or so) and reloads nginx.

## 7. nginx

Each repo carries its own server blocks in `deploy/nginx.conf`. All three use the certificate from step 6.

```bash
sudo cp /srv/nodepress/api/deploy/nginx.conf   /etc/nginx/sites-available/nodepress-api.conf
sudo cp /srv/nodepress/web/deploy/nginx.conf   /etc/nginx/sites-available/nodepress-web.conf
sudo cp /srv/nodepress/admin/deploy/nginx.conf /etc/nginx/sites-available/nodepress-admin.conf
sudo ln -s /etc/nginx/sites-available/nodepress-*.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

(Where nginx reads `/etc/nginx/conf.d/` instead, copy the three files there.)

## 8. The demo clients

Makes Kettle & Crumb and Studio Halden, with their pictures, owned by one account (see `demo/`):

```bash
cd /srv/nodepress/api
SEED_ADMIN_PASSWORD='<12 or more characters>' npm run demo -- \
  --email <the person who will sign in> --domain nodepress.brainxdemo.com
```

With an account that already exists, its password is kept and `SEED_ADMIN_PASSWORD` can be left out.
Running it again refuses to make a client twice; `--replace` deletes and remakes them.

## 9. Check

- `https://kettle-and-crumb.nodepress.brainxdemo.com/` and `https://studio-halden.nodepress.brainxdemo.com/`
  show the two sites with their photos and logos.
- `https://admin.nodepress.brainxdemo.com/`: sign in as the demo account; the Site switcher lists both.
- In the admin, change a published page and save: the site shows the change on the next visit.
- Upload a picture under Media: it loads from `https://api.nodepress.brainxdemo.com/uploads/…`.

## Updating

```bash
cd /srv/nodepress/api   && git pull && npm ci && npm run db:migrate && pm2 restart nodepress-api
cd /srv/nodepress/web   && git pull && npm ci && npm run build && pm2 restart nodepress-web
cd /srv/nodepress/admin && git pull && npm ci && npm run build
```

To go back, check out the previous commit in that repo and run the same line; `npm run db:revert`
undoes the newest migration, one per run.

## What to back up

The database and `/srv/nodepress/uploads` (the pictures). Everything else can be rebuilt from the
repositories and the three `.env` files.
