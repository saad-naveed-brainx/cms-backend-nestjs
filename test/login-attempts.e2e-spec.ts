import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { LoginAttempts } from '../src/auth/login-attempts.service.js';
import { PasswordService } from '../src/auth/password.service.js';
import { createTestApp } from './support/app.js';
import { resetDatabase } from './support/database.js';
import { invite, newClient } from './support/invitations.js';
import { TEST_PASSWORD, seedUser } from './support/seed.js';

/**
 * The sign-in limit (users-roles T4, plan D8) through the real routes, on real Postgres: 10 wrong
 * passwords for one email within 15 minutes pause it for 15 minutes, at sign-in and when joining
 * with an existing account.
 *
 * Time: the app's `LoginAttempts` is swapped for one on a clock the test moves, so "15 minutes
 * later" takes no waiting; `createTestApp` cannot swap a provider, so the app is built here. The
 * last test uses the app untouched, so the real wiring is proved too. The counts live in memory
 * and survive `resetDatabase`, so `beforeEach` moves the clock a day on: whatever an earlier test
 * left is long over, and each test starts from nothing.
 */

// Provisioning and unknown emails hash with production-cost scrypt (about 0.2 s each).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const FIFTEEN_MINUTES = 15 * MINUTE;
const DAY = 24 * 60 * MINUTE;

const SARA = 'sara@x.test';
const DANA = 'dana@x.test';
const NOBODY = 'nobody@x.test';
const WRONG = 'not the right password';

const pausedFor = (minutes: string) =>
  `Too many sign-in attempts. Try again in ${minutes}.`;

let app: INestApplication;
let dataSource: DataSource;
let now = Date.parse('2026-10-30T09:00:00.000Z');

const signIn = (email: string, password: string, on = app) =>
  request(on.getHttpServer()).post('/auth/login').send({ email, password });
const accept = (token: string, password: string) =>
  request(app.getHttpServer())
    .post('/invitations/accept')
    .send({ token, password });

/** `times` wrong passwords on the sign-in page, each the ordinary 401. */
async function wrongSignIns(email: string, times: number, on = app) {
  for (let attempt = 1; attempt <= times; attempt++) {
    const res = await signIn(email, WRONG, on);
    expect(res.status, `wrong password ${attempt} of ${times}`).toBe(401);
    expect(res.body.message).toBe('Invalid email or password');
  }
}

/** `times` wrong passwords on an invite page, each the ordinary 401. */
async function wrongAccepts(token: string, times: number) {
  for (let attempt = 1; attempt <= times; attempt++) {
    const res = await accept(token, WRONG);
    expect(res.status, `wrong password ${attempt} of ${times}`).toBe(401);
    expect(res.body.message).toBe('Invalid email or password');
  }
}

function expectPaused(
  res: { status: number; headers: Record<string, string>; body: any },
  seconds: number,
  message: string,
) {
  expect(res.status).toBe(429);
  expect(res.headers['retry-after']).toBe(String(seconds));
  expect(res.body.message).toBe(message);
}

const seedSara = () =>
  seedUser(dataSource, { email: SARA, name: 'Sara', password: TEST_PASSWORD });

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(LoginAttempts)
    .useValue(new LoginAttempts(() => now))
    .compile();
  app = moduleRef.createNestApplication();
  await app.init();
  await app.listen(0, '127.0.0.1');
  dataSource = app.get(DataSource);
});

beforeEach(async () => {
  now += DAY;
  await resetDatabase(dataSource);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await app.close();
});

describe('POST /auth/login', () => {
  it('[UC-UR-19] the 11th attempt is a 429 even with the right password, until 15 minutes after the 10th, then the right password works', async () => {
    await seedSara();

    // A minute apart: the pause runs from the 10th, whatever the 1st has aged to by then.
    for (let attempt = 1; attempt <= 9; attempt++) {
      await wrongSignIns(SARA, 1);
      now += MINUTE;
    }
    await wrongSignIns(SARA, 1);
    const tenth = now;

    expectPaused(
      await signIn(SARA, TEST_PASSWORD),
      900,
      pausedFor('15 minutes'),
    );

    // It counts down, and trying again, right or wrong, does not put the end off.
    now = tenth + 14 * MINUTE - SECOND;
    expectPaused(await signIn(SARA, WRONG), 61, pausedFor('2 minutes'));
    now = tenth + 14 * MINUTE;
    expectPaused(await signIn(SARA, TEST_PASSWORD), 60, pausedFor('1 minute'));
    now = tenth + FIFTEEN_MINUTES - SECOND;
    expectPaused(await signIn(SARA, TEST_PASSWORD), 1, pausedFor('1 minute'));

    now = tenth + FIFTEEN_MINUTES;
    const back = await signIn(SARA, TEST_PASSWORD);
    expect(back.status).toBe(200);
    expect(back.body.accessToken).toEqual(expect.any(String));
  });

  it('[UC-UR-19] a success resets the count: no pause after 9 wrong, the right one, 9 more wrong', async () => {
    await seedSara();

    await wrongSignIns(SARA, 9);
    expect((await signIn(SARA, TEST_PASSWORD)).status).toBe(200);
    await wrongSignIns(SARA, 9);
    expect((await signIn(SARA, TEST_PASSWORD)).status).toBe(200);

    // A reset, not a limit that is off: ten in a row after it still pause.
    await wrongSignIns(SARA, 10);
    expectPaused(
      await signIn(SARA, TEST_PASSWORD),
      900,
      pausedFor('15 minutes'),
    );
  });

  it('[UC-UR-19] an unknown email is paused the same way as a real one, and a paused email costs no hashing', async () => {
    await seedSara();
    await wrongSignIns(SARA, 10);
    await wrongSignIns(NOBODY, 10);

    const passwords = app.get(PasswordService);
    const verify = vi.spyOn(passwords, 'verify');
    const verifyAgainstDummy = vi.spyOn(passwords, 'verifyAgainstDummy');

    const real = await signIn(SARA, WRONG);
    const unknown = await signIn(NOBODY, WRONG);
    expectPaused(real, 900, pausedFor('15 minutes'));
    expectPaused(unknown, 900, pausedFor('15 minutes'));
    expect(unknown.body).toEqual(real.body);
    expect(verify).not.toHaveBeenCalled();
    expect(verifyAgainstDummy).not.toHaveBeenCalled();

    now += FIFTEEN_MINUTES;
    await wrongSignIns(NOBODY, 1);
  });

  it('[UC-UR-19] another email is unaffected while Sara is paused', async () => {
    await seedSara();
    await seedUser(dataSource, {
      email: DANA,
      name: 'Dana',
      password: TEST_PASSWORD,
    });

    await wrongSignIns(SARA, 10);
    expectPaused(
      await signIn(SARA, TEST_PASSWORD),
      900,
      pausedFor('15 minutes'),
    );

    await wrongSignIns(DANA, 1);
    await wrongSignIns(NOBODY, 1);
    const dana = await signIn(DANA, TEST_PASSWORD);
    expect(dana.status).toBe(200);
    expect(dana.body.user.email).toBe(DANA);
  });

  it('[UC-UR-19] the app as it really starts, on the real clock, pauses too', async () => {
    const real = await createTestApp();
    await real.app.listen(0, '127.0.0.1');
    try {
      await seedSara();
      await wrongSignIns(SARA, 10, real.app);

      const paused = await signIn(SARA, TEST_PASSWORD, real.app);
      expect(paused.status).toBe(429);
      expect(Number(paused.headers['retry-after'])).toBeGreaterThan(890);
      expect(Number(paused.headers['retry-after'])).toBeLessThanOrEqual(900);
      expect(paused.body.message).toBe(pausedFor('15 minutes'));
    } finally {
      await real.app.close();
    }
  });
});

describe('POST /invitations/accept', () => {
  it("[UC-UR-19] wrong passwords on Sara's invite page count for Sara too, and the link still works after the pause", async () => {
    const olivia = await newClient(app, {
      prefix: 'kettle',
      adminName: 'Olivia Owner',
      siteName: 'Kettle & Crumb',
    });
    const sara = await seedSara();
    const { token } = await invite(app, olivia, SARA, 'Editor');

    // Five at sign-in and five on the invite page: one count, whichever door.
    await wrongSignIns(SARA, 5);
    await wrongAccepts(token, 5);
    expectPaused(
      await accept(token, TEST_PASSWORD),
      900,
      pausedFor('15 minutes'),
    );
    expectPaused(
      await signIn(SARA, TEST_PASSWORD),
      900,
      pausedFor('15 minutes'),
    );

    // Past the pause and past those ten failures' 15 minutes: the invite still waits, and joining
    // with the right password is a success like any other, so it clears the nine before it.
    now += FIFTEEN_MINUTES + SECOND;
    await wrongAccepts(token, 9);
    const joined = await accept(token, TEST_PASSWORD);
    expect(joined.status).toBe(200);
    expect(joined.body.user.id).toBe(sara.id);
    expect(
      joined.body.memberships.map((m: { site: { id: string } }) => m.site.id),
    ).toEqual([olivia.siteId]);

    await wrongSignIns(SARA, 9);
    expect((await signIn(SARA, TEST_PASSWORD)).status).toBe(200);
  });
});
