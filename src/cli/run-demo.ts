import { NestFactory } from '@nestjs/core';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { AppModule } from '../app.module.js';
import { appearanceBody } from '../appearance/appearance-input.js';
import { AppearanceService } from '../appearance/appearance.service.js';
import type { SiteAccess } from '../auth/decorators.js';
import { Permission } from '../auth/permission.js';
import { createTypeBody } from '../content/content-type-input.js';
import { ContentTypesService } from '../content/content-types.service.js';
import { createPageBody, updatePageBody } from '../content/content-input.js';
import { ContentRepository } from '../content/content.repository.js';
import { ContentService } from '../content/content.service.js';
import { MediaService } from '../media/media.service.js';
import { PlatformRepository } from '../platform/platform.repository.js';
import { ProvisioningService } from '../provisioning/provisioning.service.js';
import { SiteRemovalService } from '../site-removal/site-removal.service.js';

/**
 * `npm run demo` (DEP-03 minimum, D-044): makes the demo clients from the folders in `demo/`, each a
 * `content.json` and its `images/`, through the same services the API's routes use: the site and its
 * address (provisioning, as the seed command does), its pictures (the media library), its look and
 * logo (Appearance), its content types, and its pages, posts and items, published. Nothing about the
 * clients is in code: change the files and run it again with `--replace`.
 */

export type DemoIo = {
  out: (line: string) => void;
  err: (line: string) => void;
};

/** The running application, as far as the command needs it. */
export type DemoApp = {
  provisioning: ProvisioningService;
  platform: PlatformRepository;
  removal: SiteRemovalService;
  media: MediaService;
  appearance: AppearanceService;
  types: ContentTypesService;
  content: ContentService;
  pages: ContentRepository;
  close: () => Promise<void>;
};

async function openNestApp(): Promise<DemoApp> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
    abortOnError: false,
  });
  return {
    provisioning: app.get(ProvisioningService),
    platform: app.get(PlatformRepository),
    removal: app.get(SiteRemovalService),
    media: app.get(MediaService),
    appearance: app.get(AppearanceService),
    types: app.get(ContentTypesService),
    content: app.get(ContentService),
    pages: app.get(ContentRepository),
    close: () => app.close(),
  };
}

/** One client's `content.json`. Blocks are checked by the content routes' own rules when saved. */
const clientFile = z.strictObject({
  organization: z.string().min(1),
  site: z.string().min(1),
  /** The first part of the site's web address: `kettle-and-crumb` is `kettle-and-crumb.<domain>`. */
  address: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  appearance: z.strictObject({
    tagline: z.string(),
    footerNote: z.string(),
    logo: z.string().optional(),
    theme: z.record(z.string(), z.unknown()),
  }),
  /** The files in `images/` to add to the library, in this order. */
  pictures: z.array(z.string().min(1)),
  types: z.array(z.strictObject({ name: z.string(), urlPrefix: z.string() })),
  items: z.array(
    z.looseObject({ type: z.string(), slug: z.string(), title: z.string() }),
  ),
});
type ClientFile = z.infer<typeof clientFile>;

type DemoArgs = {
  email: string;
  name: string;
  domain: string;
  replace: boolean;
  from: string;
};

function parseArgs(argv: string[]): DemoArgs | string {
  const args: DemoArgs = {
    email: '',
    name: 'Demo Admin',
    domain: 'localhost',
    replace: false,
    from: 'demo',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--replace') {
      args.replace = true;
      continue;
    }
    const value = argv[index + 1];
    if (!['--email', '--name', '--domain', '--from'].includes(flag)) {
      return `Unknown option ${flag}. Use --email, --name, --domain, --from and --replace.`;
    }
    if (value === undefined || value.startsWith('--')) {
      return `${flag} needs a value`;
    }
    args[flag.slice(2) as 'email' | 'name' | 'domain' | 'from'] = value;
    index += 1;
  }
  if (!args.email) {
    return 'Give the account the demo sites belong to: --email you@example.com';
  }
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/i.test(args.domain)) {
    return '--domain must be a web address like localhost or example.com';
  }
  return args;
}

/** Every `"picture:<file>"` string in the blocks becomes that picture's address in the library. */
function withPictures(value: unknown, urls: Map<string, string>): unknown {
  if (typeof value === 'string' && value.startsWith('picture:')) {
    const url = urls.get(value.slice('picture:'.length));
    if (!url) throw new Error(`No picture called ${value.slice(8)} in images/`);
    return url;
  }
  if (Array.isArray(value)) return value.map((one) => withPictures(one, urls));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, one]) => [key, withPictures(one, urls)]),
    );
  }
  return value;
}

/** Throws the content routes' own 400 as one readable line. */
function check<T extends z.ZodType>(
  schema: T,
  value: unknown,
  what: string,
): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new Error(
    `${what}: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
  );
}

async function makeClient(
  app: DemoApp,
  args: DemoArgs,
  folder: string,
  client: ClientFile,
  env: Record<string, string | undefined>,
  io: DemoIo,
): Promise<void> {
  const host = `${client.address}.${args.domain}`;
  const existing = await app.platform.findSiteByHostname(host);
  if (existing) {
    if (!args.replace) {
      throw new Error(
        `${host} is already a site (${existing.name}). Run again with --replace to make it afresh.`,
      );
    }
    const owner = await app.platform.findUserByEmail(args.email);
    if (!owner)
      throw new Error(
        `${args.email} has no account, so cannot replace ${host}`,
      );
    await app.removal.remove(owner.id, existing.id);
    io.out(`  Deleted the old ${existing.name} at ${host}.`);
  }

  const known = await app.platform.findUserByEmail(args.email);
  const made = await app.provisioning.provisionTenant({
    organizationName: client.organization,
    siteName: client.site,
    hostnames: [host],
    admin: {
      email: args.email,
      name: args.name,
      ...(known || !env.SEED_ADMIN_PASSWORD
        ? {}
        : { password: env.SEED_ADMIN_PASSWORD }),
    },
  });
  if (made.admin.generatedPassword !== undefined) {
    io.out(
      `  New account ${args.email}. Generated password (shown once, keep it safe): ${made.admin.generatedPassword}`,
    );
  }
  const siteId = made.site.id;
  const user = (await app.platform.findUserByEmail(args.email))!;
  const access: SiteAccess = {
    siteId,
    roleId: '',
    roleName: 'Administrator',
    permissions: Object.values(Permission),
  };
  const who = { id: user.id };

  const urls = new Map<string, string>();
  for (const file of client.pictures) {
    const buffer = await readFile(join(folder, 'images', file));
    const picture = await app.media.upload(siteId, user.id, {
      originalname: file,
      buffer,
    });
    urls.set(file, picture.url);
  }

  const { logo, ...look } = client.appearance;
  await app.appearance.update(
    siteId,
    check(
      appearanceBody,
      {
        ...look,
        ...(logo ? { logoUrl: withPictures(`picture:${logo}`, urls) } : {}),
      },
      `${client.site} appearance`,
    ),
  );

  for (const type of client.types) {
    await app.types.create(
      siteId,
      check(createTypeBody, type, `${client.site} type ${type.name}`),
    );
  }

  for (const raw of client.items) {
    const { type, slug, ...fields } = withPictures(
      raw,
      urls,
    ) as ClientFile['items'][number];
    const what = `${client.site} ${type} ${slug}`;
    // Every new site starts with its Home page (D-037): it is filled in, not made again.
    const home =
      type === 'page' && slug === 'home'
        ? await app.pages.findByPath(siteId, '/home')
        : null;
    if (home) {
      await app.content.update(
        access,
        who,
        home.id,
        check(updatePageBody, fields, what),
      );
      continue;
    }
    const page = await app.content.create(
      access,
      who,
      check(createPageBody, { type, slug, ...fields }, what),
    );
    await app.content.publish(access, who, page.id);
  }

  io.out(
    `  ${client.site} at ${host}: ${client.pictures.length} pictures, ${client.types.length} content type, ${client.items.length} pages and items, all published.`,
  );
}

/**
 * The demo command, as a function: 0 when every client was made, 1 otherwise. It writes only to `io`.
 * The account is made when it does not exist (its password is `SEED_ADMIN_PASSWORD`, else one is made
 * up and shown once), and owns every demo client's organisation, so one sign-in shows them all.
 */
export async function runDemo(
  argv: string[],
  env: Record<string, string | undefined>,
  io: DemoIo,
  openApp: () => Promise<DemoApp> = openNestApp,
): Promise<number> {
  const args = parseArgs(argv);
  if (typeof args === 'string') {
    io.err(args);
    return 1;
  }

  const root = resolve(args.from);
  let clients: { folder: string; client: ClientFile }[];
  try {
    const folders = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name))
      .sort();
    clients = [];
    for (const folder of folders) {
      const raw: unknown = JSON.parse(
        await readFile(join(folder, 'content.json'), 'utf8'),
      );
      clients.push({
        folder,
        client: check(clientFile, raw, join(folder, 'content.json')),
      });
    }
  } catch (error) {
    io.err(
      `Could not read the demo clients in ${root}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }

  let app: DemoApp;
  try {
    app = await openApp();
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return 1;
  }

  let exitCode = 0;
  for (const { folder, client } of clients) {
    io.out(`${client.site}:`);
    try {
      await makeClient(app, args, folder, client, env, io);
    } catch (error) {
      exitCode = 1;
      const answer = (
        error as { response?: { message?: unknown; errors?: unknown } }
      ).response;
      const detail = Array.isArray(answer?.errors)
        ? ` (${answer.errors.join('; ')})`
        : '';
      io.err(
        `  ${client.site} was not finished: ${error instanceof Error ? error.message : String(error)}${detail}`,
      );
    }
  }
  if (exitCode === 0) {
    io.out(
      `Done. Sign in as ${args.email}: the Site switcher lists ${clients.map((one) => one.client.site).join(' and ')}.`,
    );
  }

  try {
    await app.close();
  } catch (error) {
    io.err(
      `The application did not close cleanly: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return exitCode;
}
