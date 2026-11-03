import { LoginAttempts } from '../src/auth/login-attempts.service.js';

/**
 * The sign-in limit's counter (users-roles T4, plan D8) on a clock the test moves, for what the
 * routes cannot show: how old failures age out, the wait to the second, one email in any case, and
 * the map staying small. `test/login-attempts.e2e-spec.ts` has the use case end to end.
 */

const MINUTE = 60 * 1000;
const SARA = 'sara@x.test';

/** A flood's worth of `fail` calls is a lot of work in a test, however the pruning is done. */
const FLOOD_TIMEOUT = 30_000;

function onFakeClock() {
  const clock = { now: Date.parse('2026-10-30T09:00:00.000Z') };
  return { clock, attempts: new LoginAttempts(() => clock.now) };
}

function fail(attempts: LoginAttempts, email: string, times: number): void {
  for (let i = 0; i < times; i++) attempts.fail(email);
}

describe('LoginAttempts', () => {
  it('[UC-UR-19] failures older than 15 minutes stop counting', () => {
    const { clock, attempts } = onFakeClock();
    fail(attempts, SARA, 9);

    // The nine have aged out, so it takes ten more to pause, not one.
    clock.now += 16 * MINUTE;
    fail(attempts, SARA, 9);
    expect(attempts.check(SARA)).toBeNull();

    attempts.fail(SARA);
    expect(attempts.check(SARA)).toEqual({ retryAfterSeconds: 900 });
  });

  it('[UC-UR-19] the wait counts down in whole seconds, rounded up, and a late failure does not extend it', () => {
    const { clock, attempts } = onFakeClock();
    fail(attempts, SARA, 10);
    const tenth = clock.now;

    clock.now = tenth + 1;
    expect(attempts.check(SARA)).toEqual({ retryAfterSeconds: 900 });

    // A request that passed the check before the pause and fails after it: two sent at once.
    clock.now = tenth + MINUTE;
    attempts.fail(SARA);
    expect(attempts.check(SARA)).toEqual({ retryAfterSeconds: 840 });

    clock.now = tenth + 15 * MINUTE - 1;
    expect(attempts.check(SARA)).toEqual({ retryAfterSeconds: 1 });

    clock.now = tenth + 15 * MINUTE;
    expect(attempts.check(SARA)).toBeNull();
  });

  it('[UC-UR-19] upper and lower case are one email, for counting, clearing and checking', () => {
    const { attempts } = onFakeClock();
    fail(attempts, 'Sara@X.test', 5);
    fail(attempts, 'sara@x.TEST', 4);

    // Cleared in another case: without that, these nine would make eighteen.
    attempts.succeed('SARA@X.TEST');
    fail(attempts, 'sara@x.test', 9);
    expect(attempts.check('sara@x.test')).toBeNull();

    attempts.fail('SARA@x.test');
    expect(attempts.check('Sara@X.Test')).toEqual({ retryAfterSeconds: 900 });
  });

  it(
    '[UC-UR-19] the map holds 10,000 emails, and one more drops the oldest',
    () => {
      const { clock, attempts } = onFakeClock();
      fail(attempts, SARA, 10);

      // A millisecond apart and all inside their 15 minutes, so only the cap can remove anything.
      for (let i = 1; i <= 9_999; i++) {
        clock.now += 1;
        attempts.fail(`person-${i}@x.test`);
      }
      expect(attempts.check(SARA)).not.toBeNull();

      clock.now += 1;
      attempts.fail('one-too-many@x.test');
      expect(attempts.check(SARA)).toBeNull();
    },
    FLOOD_TIMEOUT,
  );

  it(
    '[UC-UR-19] a write prunes emails past their 15 minutes, so the cap does not drop a live pause',
    () => {
      const { clock, attempts } = onFakeClock();
      const first = clock.now;

      // Sara is the oldest email, then a flood fills the map to its 10,000.
      attempts.fail(SARA);
      for (let i = 1; i <= 9_999; i++) {
        attempts.fail(`person-${i}@x.test`);
      }

      // Sara's other nine pause her until 29 minutes in; the flood's failures are older than that.
      clock.now = first + 14 * MINUTE;
      fail(attempts, SARA, 9);

      // The flood is 20 minutes old and has to go, not Sara, when one more email arrives.
      clock.now = first + 20 * MINUTE;
      attempts.fail('one-more@x.test');
      expect(attempts.check(SARA)).toEqual({ retryAfterSeconds: 540 });
    },
    FLOOD_TIMEOUT,
  );

  it('[UC-UR-19] with no clock given, it runs on the real time', () => {
    const attempts = new LoginAttempts();
    fail(attempts, SARA, 10);

    const paused = attempts.check(SARA);
    expect(paused).not.toBeNull();
    expect(paused?.retryAfterSeconds).toBeGreaterThan(890);
    expect(paused?.retryAfterSeconds).toBeLessThanOrEqual(900);
  });
});
