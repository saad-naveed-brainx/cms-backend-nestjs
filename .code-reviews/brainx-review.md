---
diff_hash: 1fc42f4e829298b475cc5d81567b5638cb5db077252437b9714c2967422f04d6
reviewed_at: 2026-10-30T09:19:22Z
---

## Summary

Users-roles T4 (plan D8): sign-in rate limit. Adds an in-memory `LoginAttempts`
counter keyed on lower-cased email, a `SignInPaused` HTTP 429 exception, and a
global `SignInPausedFilter` that stamps `Retry-After` on the response. The
counter sits inside `AuthService.checkPassword`, so both `/auth/login` and
`/invitations/accept` (existing-account path) share one count. Counting happens
on *start* of an attempt (before any hashing), cleared on success, so concurrent
guesses cannot slip past. Counter is bounded (10,000 emails max, oldest dropped,
stale entries pruned on each write) and injected clock (`LOGIN_CLOCK`) lets
tests move time without waiting. Comprehensive unit + e2e coverage of
UC-UR-19 and a doc paragraph added to `CLAUDE.md`. Multi-process limitation
(each process counts its own) is called out explicitly and tracked in D-049.

Design overall is careful and the invariants (no email-existence leak via
timing or response shape, no race on concurrent guesses, deterministic clock
for tests) are all respected and tested. Findings below are minor.

## Findings

### Critical (0)

### High (0)

### Medium (0)

### Low (2)

- **src/auth/auth.service.ts:73** — Failure is counted before any work that
  can throw independently of password correctness (DB lookup, hash verify).
  During a transient Postgres outage every attempt by a legitimate user —
  including with the correct password — will accrue a failure and never
  reach `succeed()`. Ten retries during a flaky-DB window can lock the user
  out for 15 minutes once the DB recovers. The "count on start" ordering is
  deliberate (concurrent-guess protection, called out in the comment on
  src/auth/auth.service.ts:71-72) and the blast radius is bounded (one email,
  15 minutes), so this is an acknowledged trade-off rather than a bug.
  *(correctness)*
  - status: open
  - dev_reasoning: N/A
  - ai_reasoning: The counter is a side-effect that outlives the request on
    an exception path, so a DB-driven 500 is indistinguishable from a wrong
    password from the limiter's point of view. If this is undesirable, a
    simple fix is to call `fail` only after the password check decides, and
    keep the concurrent-guess protection by reserving a slot in the counter
    (e.g. optimistic increment that `succeed` *and* a known-wrong result
    both release). Flagged as Low because the trade-off is clearly
    intentional and the user impact is small.

- **src/auth/login-attempts.service.ts:59-61** — `succeed()` removes only the
  one email's entry; it does not call `prune()`. Stale entries whose last
  failure aged out of the 15-minute window can linger in the map until the
  next `fail()` triggers a prune. In practice the map is bounded at 10,000
  and `pauseRemaining()` re-checks timestamps so correctness isn't affected,
  but memory held by a long-idle process can stay near the cap after a
  burst of failures with no later writes. *(maintainability)*
  - status: open
  - dev_reasoning: N/A
  - ai_reasoning: Not a correctness bug — the comment "The emails are in the
    order of their last failure" and `pauseRemaining`'s length-and-time
    guard mean a stale array of 10 cannot cause a false pause. Mentioning it
    only because the `prune` doc-comment suggests pruning runs on every
    write, and `succeed` is a write that silently skips it. Either call
    `prune(this.now())` at the top of `succeed`, or tighten the comment to
    "pruned on each `fail`".

## Reviewed files

- CLAUDE.md — doc paragraph for the sign-in limit; accurate.
- src/auth/auth.controller.ts — doc update only (429 note).
- src/auth/auth.module.ts — registers `LoginAttempts`, `LOGIN_CLOCK` provider,
  and `SignInPausedFilter` via `APP_FILTER`. Module wiring looks right.
- src/auth/auth.service.ts — adds the limiter around `checkPassword`. Order
  (check → fail → verify → succeed) is sound given the stated concurrent-
  guess constraint (see Finding 1).
- src/auth/login-attempts.service.ts — new. Clean, bounded, deterministic
  under injected clock. Prune walks oldest-first and short-circuits.
- src/auth/sign-in-paused.filter.ts — new. Extends `BaseExceptionFilter`,
  sets `Retry-After` before delegating to super.
- src/invitations/invitations.service.ts — doc update only (429 propagates).
- test/auth.service.spec.ts — passes a plain `new LoginAttempts()` into the
  test setup; relies on the constructor's default clock. Fine.
- test/login-attempts.service.spec.ts — new. Unit tests for ageing, counting,
  case-insensitivity, map cap, prune-vs-cap interaction, real-clock mode.
- test/login-attempts.e2e-spec.ts — new. End-to-end UC-UR-19 across login
  and invite-accept doors, pause expiry, independence of other emails,
  unknown-email parity, and real-wiring smoke test.
