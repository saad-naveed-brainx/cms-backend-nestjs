---
commit: 755d83e8bb11fd6d1bc1cb1bde3fcf20e004cdc9
branch: devflow/organizations
author: saad-naveed-brainx
timestamp: 2026-11-03T17:49:00+05:00
reviewed_at: 2026-11-03T12:49:32Z
stack: unknown
score: 100
status: pass
critical: 0
high: 0
medium: 0
low: 0
open: 0
skipped: 0
ignored: 0
resolved: 1
---

## Summary

Organizations T1: the sign-in / `/auth/me` / invitation-accept responses now carry an
`organizations` list (every org the user owns or has a site in, including owned-but-site-less
ones), each membership's `site` now carries `organizationId`, and `POST /invitations/lookup`
now returns `site.id` and a new `organization { id, name }` so the admin's invite page can
name the organisation and land back on the site by id.

Implementation layers up cleanly: `PlatformRepository.findMembershipsByUserId` adds a join on
`organizations` and surfaces both `site.organizationId` and a nested `organization { id, name }`;
`InvitationAcceptanceRepository.findByTokenHash` adds the same join to expose
`organizationId`/`organizationName`; `AuthService` replaces `memberships()` with a private
`access()` helper that merges membership-derived orgs with `findOrganizationsOwnedBy` (new,
already present in the platform desk) and de-duplicates by id with a name/id sort; `LoginResult`
is refactored to `Profile & { accessToken, tokenType, expiresAt }` so the two responses stay
in sync by type. Test coverage includes a dedicated `organizations-profile.e2e-spec.ts` with
real Postgres + real sign-ins covering UC-OR-01 (profile lists orgs) and UC-OR-02 (invitation
lookup names its site and organization), plus existing login/token/invitation-accept/
provisioning specs updated to assert the new shape.

Invariant 1 (tenant scoping): preserved — only the already-sanctioned unscoped desks
(`PlatformRepository`, `InvitationAcceptanceRepository`) read across sites. The platform desk
still has exactly the five methods its own doc comment pins. The new test file uses `DataSource`
directly, which is in the test/ exception the invariant allows.

Cross-repo contract note: this changes the shape returned by `/auth/login`, `/auth/me` and
`/invitations/accept` (adds `organizations`, adds `site.organizationId` on each membership) and
by `/invitations/lookup` (adds `site.id`, adds `organization`). The admin repo almost certainly
needs matching type updates — flag if admin isn't being updated in parallel; this review only
sees api/.

Re-review (2026-11-03T12:49:32Z): the only prior finding (Low, parallelism in `access()`) has
been addressed — `src/auth/auth.service.ts:130-131` now runs both platform reads with
`Promise.all`. No new findings raised (re-review scope).

## Findings

### Critical (0)

_None._

### High (0)

_None._

### Medium (0)

_None._

### Low (1)

- **src/auth/auth.service.ts:130-131** — `access()` awaits `findMembershipsByUserId` and
  `findOrganizationsOwnedBy` sequentially. The two queries are independent (different tables,
  neither feeds the other), so `Promise.all` would halve round-trip latency on `/auth/me` and
  `/auth/login`. *(performance)*
  - status: fixed
  - dev_reasoning: N/A
  - ai_reasoning: Fixed in the staged diff: `access()` at `src/auth/auth.service.ts:130-133`
    now runs both platform reads concurrently via
    `const [rows, owned] = await Promise.all([this.platform.findMembershipsByUserId(userId), this.platform.findOrganizationsOwnedBy(userId)]);`,
    exactly as the finding recommended. Both queries remain independent and small, and the
    downstream dedupe/sort logic is unchanged.

## Reviewed files

- CLAUDE.md — doc update for the new response shape and the T1 reference; no code impact.
- src/auth/auth.service.ts — new `OrganizationSummary`, `LoginResult` restructured as
  `Profile & {...}`, private `access()` merges memberships with owned orgs using `Promise.all`.
- src/invitations/invitation-acceptance.repository.ts — adds `organizations` join; exposes
  `organizationId`/`organizationName` on `FoundInvitation` row + typed select.
- src/invitations/invitations.service.ts — `InvitationLookup` adds `site.id` and
  `organization { id, name }`; `lookup()` wires them through.
- src/platform/platform.repository.ts — `UserMembership` adds `site.organizationId` and
  `organization { id, name }`; query already joined `organizations`, now selects its name.
- test/auth-login.e2e-spec.ts — asserts `organizations` key and `site.organizationId` on each
  membership.
- test/auth-token.e2e-spec.ts — same shape assertions on `/auth/me`.
- test/auth.service.spec.ts — mock desk mirrors the new shape; adds `findOrganizationsOwnedBy`
  stub, `organizationsOf()` helper, and assertions.
- test/invitations-accept.e2e-spec.ts — lookup response assertion updated to include
  `site.id` and `organization`.
- test/organizations-profile.e2e-spec.ts — new file, two UCs (UC-OR-01, UC-OR-02) with real
  Postgres: covers owned-no-site org, multiple orgs sorted by name, and the invitation flow
  carrying `organizations` through to the accept response.
- test/provisioning.e2e-spec.ts — membership shape updated to include `organizationId`.
