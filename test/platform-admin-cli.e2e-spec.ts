import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { runCreateSuperAdmin } from '../src/cli/run-create-super-admin.js';
import { User } from '../src/database/entities/index.js';
import { PlatformAdminService } from '../src/platform-admin/platform-admin.service.js';
import { createTestApp } from './support/app.js';
import { resetDatabase } from './support/database.js';
import { newClient } from './support/invitations.js';

/**
 * Platform admin T1: the super admin flag, the `create-super-admin` command and the profile that
 * says who is one. Real Postgres, real hashing; the command runs against the real service with a
 * fake output.
 */

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

let app: INestApplication;
let dataSource: DataSource;
const api = () => request(app.getHttpServer());

beforeAll(async () => {
  ({ app, dataSource } = await createTestApp());
});
beforeEach(async () => {
  await resetDatabase(dataSource);
});
afterAll(async () => {
  await app.close();
});

const PASSWORD = 'ops-platform-password';

/** Runs the command like `npm run create-super-admin`, with the app's own service and a fake screen. */
async function run(argv: string[], env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCreateSuperAdmin(
    argv,
    env,
    { out: (line) => out.push(line), err: (line) => err.push(line) },
    async () => ({
      platformAdmin: app.get(PlatformAdminService),
      close: async () => {},
    }),
  );
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const userRow = (email: string) =>
  dataSource.getRepository(User).findOneByOrFail({ email });

describe('create-super-admin', () => {
  it('[UC-PA-01] makes a new account that signs in and is a super admin', async () => {
    const { code } = await run(
      ['--email', 'Ops@Platform.test', '--name', 'Ops'],
      { SUPER_ADMIN_PASSWORD: PASSWORD },
    );

    expect(code).toBe(0);
    const row = await userRow('ops@platform.test');
    expect(row.isPlatformAdmin).toBe(true);
    expect(row.name).toBe('Ops');
    const login = await api()
      .post('/auth/login')
      .send({ email: 'ops@platform.test', password: PASSWORD })
      .expect(200);
    expect(login.body.user.isPlatformAdmin).toBe(true);
    const me = await api()
      .get('/auth/me')
      .set('Authorization', `Bearer ${login.body.accessToken}`)
      .expect(200);
    expect(me.body.user.isPlatformAdmin).toBe(true);
  });

  it('[UC-PA-01] a new account with no password gets a generated one, printed once', async () => {
    const { code, out } = await run([
      '--email',
      'gen@platform.test',
      '--name',
      'Gen',
    ]);

    expect(code).toBe(0);
    const password = /keep it safe\): (\S+)/.exec(out)?.[1];
    expect(password).toBeTruthy();
    await api()
      .post('/auth/login')
      .send({ email: 'gen@platform.test', password })
      .expect(200);
    expect(JSON.stringify(await userRow('gen@platform.test'))).not.toContain(
      password,
    );
  });

  it('[UC-PA-02] promotes an existing account and leaves its password and name alone', async () => {
    const hal = await newClient(app, {
      prefix: 'hal',
      adminName: 'Hal Owner',
      siteName: 'Hal Site',
    });
    const before = await userRow('hal-owner@hal.test');

    const { code, out } = await run(['--email', 'hal-owner@hal.test']);

    expect(code).toBe(0);
    expect(out).toContain('existing account');
    const after = await userRow('hal-owner@hal.test');
    expect(after.isPlatformAdmin).toBe(true);
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(after.name).toBe('Hal Owner');
    expect(hal.userId).toBe(after.id);
    await api()
      .post('/auth/login')
      .send({ email: 'hal-owner@hal.test', password: 'hal-owner-password' })
      .expect(200);
  });

  it('[UC-PA-02] refuses a name or password for an account that exists, and a new account with no name', async () => {
    await newClient(app, {
      prefix: 'pat',
      adminName: 'Pat',
      siteName: 'Pat Site',
    });

    const named = await run([
      '--email',
      'pat-owner@pat.test',
      '--name',
      'Other',
    ]);
    const noName = await run(['--email', 'nobody@platform.test']);

    expect(named.code).toBe(1);
    expect(noName.code).toBe(1);
    expect(noName.err).toContain('--name');
    expect(
      await dataSource
        .getRepository(User)
        .countBy({ email: 'nobody@platform.test' }),
    ).toBe(0);
    expect((await userRow('pat-owner@pat.test')).isPlatformAdmin).toBe(false);
  });

  it('[UC-PA-27] --revoke takes the power away at once, for the same token', async () => {
    await run(['--email', 'ops@platform.test', '--name', 'Ops'], {
      SUPER_ADMIN_PASSWORD: PASSWORD,
    });
    const login = await api()
      .post('/auth/login')
      .send({ email: 'ops@platform.test', password: PASSWORD })
      .expect(200);
    const auth = { Authorization: `Bearer ${login.body.accessToken}` };

    const revoked = await run(['--email', 'ops@platform.test', '--revoke']);

    expect(revoked.code).toBe(0);
    const me = await api().get('/auth/me').set(auth).expect(200);
    expect(me.body.user.isPlatformAdmin).toBe(false);
    expect((await userRow('ops@platform.test')).isPlatformAdmin).toBe(false);
  });

  it('[UC-PA-27] --revoke on an email with no account is an error and writes nothing', async () => {
    const { code, err } = await run([
      '--email',
      'ghost@platform.test',
      '--revoke',
    ]);

    expect(code).toBe(1);
    expect(err).toContain('ghost@platform.test');
  });
});

describe('the profile', () => {
  it('[UC-PA-35] says isPlatformAdmin: false for an ordinary person, on sign-in and /auth/me', async () => {
    await newClient(app, {
      prefix: 'ola',
      adminName: 'Ola',
      siteName: 'Ola Site',
    });

    const login = await api()
      .post('/auth/login')
      .send({ email: 'ola-owner@ola.test', password: 'ola-owner-password' })
      .expect(200);
    const me = await api()
      .get('/auth/me')
      .set('Authorization', `Bearer ${login.body.accessToken}`)
      .expect(200);

    for (const answer of [login.body, me.body]) {
      expect(answer.user.isPlatformAdmin).toBe(false);
      expect(Object.keys(answer.user).sort()).toEqual([
        'email',
        'id',
        'isPlatformAdmin',
        'name',
      ]);
      expect(answer.organizations).toHaveLength(1);
      expect(answer.memberships).toHaveLength(1);
    }
  });
});
