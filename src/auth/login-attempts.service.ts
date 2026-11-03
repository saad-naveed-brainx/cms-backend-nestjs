import { Inject, Injectable } from '@nestjs/common';

/** This many failures within `WINDOW_MS` pause an email until `WINDOW_MS` after the last (plan D8). */
const MAX_FAILURES = 10;
const WINDOW_MS = 15 * 60 * 1000;

/** At most this many emails are remembered, so a flood of made-up ones cannot exhaust memory. */
const MAX_EMAILS = 10_000;

/** The token for "the time now, in milliseconds". Tests replace it to move time without waiting. */
export const LOGIN_CLOCK = Symbol('LOGIN_CLOCK');

/**
 * The sign-in limit: failure times per email, an unknown email counted like any other, so nothing
 * says which emails have accounts. It lives in this process's memory, so a restart clears it and
 * several API processes would each count their own (docs/DECISIONS.md D-049).
 */
@Injectable()
export class LoginAttempts {
  /**
   * Each email's failure times, never more than `MAX_FAILURES` because a paused email stops
   * counting. The emails are in the order of their last failure, so the first is the oldest.
   */
  private readonly failures = new Map<string, number[]>();

  constructor(
    @Inject(LOGIN_CLOCK) private readonly now: () => number = () => Date.now(),
  ) {}

  /** How long the email is still paused, or `null` when it may try. */
  check(email: string): { retryAfterSeconds: number } | null {
    const remaining = this.pauseRemaining(key(email), this.now());
    return remaining > 0
      ? { retryAfterSeconds: Math.ceil(remaining / 1000) }
      : null;
  }

  /** Counts a failure. A failure during a pause is ignored, so it cannot lengthen the pause. */
  fail(email: string): void {
    const now = this.now();
    this.prune(now);

    const address = key(email);
    if (this.pauseRemaining(address, now) > 0) return;

    const recent = (this.failures.get(address) ?? []).filter(
      (at) => at + WINDOW_MS > now,
    );
    // Deleted first, so setting it again moves the email to the end of the map.
    this.failures.delete(address);
    this.failures.set(address, [...recent, now]);

    if (this.failures.size > MAX_EMAILS) {
      this.failures.delete(this.failures.keys().next().value as string);
    }
  }

  /** The email proved its password: its count starts again. */
  succeed(email: string): void {
    this.prune(this.now());
    this.failures.delete(key(email));
  }

  /** Takes back the newest failure, for an attempt that broke before it tried any password. */
  retract(email: string): void {
    this.prune(this.now());

    const address = key(email);
    const times = this.failures.get(address);
    times?.pop();
    if (times?.length === 0) this.failures.delete(address);
  }

  /** Milliseconds left of the email's pause, 0 or less when it is not paused. */
  private pauseRemaining(address: string, now: number): number {
    const times = this.failures.get(address);
    return times && times.length >= MAX_FAILURES
      ? times[times.length - 1] + WINDOW_MS - now
      : 0;
  }

  /** Forgets emails whose last failure has left the window. They come first, so this stops early. */
  private prune(now: number): void {
    for (const [address, times] of this.failures) {
      if (times[times.length - 1] + WINDOW_MS > now) return;
      this.failures.delete(address);
    }
  }
}

function key(email: string): string {
  return email.trim().toLowerCase();
}
