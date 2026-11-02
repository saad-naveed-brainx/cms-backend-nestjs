---
diff_hash: 1495645bb8fe1d837c9834661c2578bc48aab60292f86eee90a3e012deb735e4
reviewed_at: 2026-11-02T14:36:11Z
---

## Summary

Stack: NestJS (NestJS 12 + TypeORM, API repo). The change is test-only plus a doc update — no `src/` code is touched.

Scope reviewed:
- `test/support/two-clients.ts` (new, 334 lines): a reusable "world" for the tenant isolation sweep. It stands up two real clients (Acorn and Birch) through the production provisioning/invite/media/content paths, deliberately colliding on the same page path (`/about`), draft path (`/draft`), content type path (`/recipes`), and one person (`pat@both.test`) who belongs to both sites. Also exports `fingerprint()` (per-site hash of every row in every `site_id`-bearing table, discovered via `information_schema`), `tenantTables()`, and `ownedIds()`.
- `test/tenant-isolation.e2e-spec.ts` (new, 1278 lines): the FND-03 / GOV-08b invariant. A single `ROUTES` table is cross-checked against what Nest actually declares at runtime (reading `@Public`, `@SiteScoped`, `@RequirePermission` from controller metadata), then each side attacks the other through every closed route — spelled site headers, foreign ids under one's own header, smuggled `siteId`/`site_id` in body, multipart form, and query string. The victim is fingerprinted before and after every attack. Public doors (`/public/site`, `/uploads/:siteId/:name`, `/sites/resolve`, `/public/preview`), invitations, and preview links get the same treatment, plus a focused "hunt" section (filters by foreign type id, mixed-site role ids, same-email invitations, member removal, site deletion).
- `CLAUDE.md`: invariant 7 renamed to point at the new test, and a new gotcha section documents the table and the author's responsibility to mark `ids`/`disposable` (B-43) when adding a route.

Overall this is high-quality test infrastructure: real app, real database, real tokens, no mocks (as HUNT.md's "proof the checks can fail" demonstrates — four deliberate code regressions were caught). SQL in test helpers uses parameterised values for user-supplied inputs; the only string-interpolated identifiers (table and column names) come from the hardcoded `ROUTES` definitions or from `information_schema`, both trusted sources. Typecheck passes. The CLAUDE.md edit is consistent with the shipped test and with D-052.

No Critical, High, or Medium findings. Two Low notes below.

## Findings

### Critical (0)
_None._

### High (0)
_None._

### Medium (0)
_None._

### Low (2)
- **test/support/two-clients.ts:213** — `mediaName: String(media.url).split('/').pop() as string` relies on a non-empty, slash-separated `media.url` from the API; if that contract ever changes, `.pop()` returns `undefined` and the `as string` cast silently propagates `undefined` deep into later tests (`url(siteId, mediaName)` in UC-TI-09, SQL params in UC-TI-11), producing a confusing failure far from here. *(maintainability)*
  - status: open
  - dev_reasoning: N/A
  - ai_reasoning: A one-line check (`if (!media.url) throw new Error('media endpoint returned no url')`) would surface the real breakage at setup time instead of inside an unrelated expectation. No functional risk today because `POST /media` is required by MED-01 to return `url`.

- **test/tenant-isolation.e2e-spec.ts:479** — `expect(found.size).toBeGreaterThan(25)` is a magic floor without a note on why 25 (the current app declares ~30 routes). The intent — guard against a bug where metadata scanning finds nothing and all comparisons pass trivially — is excellent, but future readers will have to re-derive it from context. *(maintainability)*
  - status: open
  - dev_reasoning: N/A
  - ai_reasoning: A one-line comment ("ROUTES has ~30 entries today; this is the floor that keeps a silently-empty scan from passing") would make the intent self-evident. No behavioural risk.

## Reviewed files
- CLAUDE.md
- test/support/two-clients.ts
- test/tenant-isolation.e2e-spec.ts
