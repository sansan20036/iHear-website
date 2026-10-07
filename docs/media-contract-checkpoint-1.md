# CP1 Media Contract + Migration

Status: CP1 PostgreSQL acceptance passed on 2026-10-07 (Asia/Taipei): all nine required cases executed against real PostgreSQL 17.11, with zero failures or skipped cases. No homepage UI or production database changes were made.

## Repository contract and implementation map

The repository stores gallery items in `public.media_galleries.items` (JSONB), not a `media_items` table. Migration 019 declares an inline CHECK on `media_galleries.id` allowing `tutoring`, `outreach`, `home`, `stories`, and `impact`. PostgreSQL's generated constraint name for this declaration is `media_galleries_id_check`; migration 024 replaces that named constraint in a transaction. A database with a renamed/missing constraint fails rather than guessing which constraint to remove. Migration numbering was rechecked: 001–023 existed when CP1 began, so 024 is the new migration.

| File | Change |
| --- | --- |
| `db/migrations/024_home_banner_gallery.sql` | Add the sixth allowed gallery ID; insert an initial `home.hero` reference only if the gallery row does not exist. |
| `lib/media-gallery-types.ts` | Add `home-banner`, optional nullable multilingual title, and read normalization. |
| `lib/media-gallery-store.ts` | Atomic file-store initialization; upgrade existing local PostgreSQL 019 schema; normalize read results without backfilling stored items; retain omitted titles. |
| `lib/media-gallery-public.ts` | Resolve current custom `home.hero` or its static fallback; expose missing title as null. |
| `app/api/media-galleries/route.ts` | Validate optional gallery filter while preserving the response envelope, authorization and cache headers. |
| `app/api/media-galleries/[id]/route.ts` | Accept nullable title and preserve existing titles when old clients omit the field. |
| `tests/media-galleries.test.mjs` | Update only the expected additive gallery count and IDs. |
| `tests/media-banner-contract.test.mjs` | Add 28 isolated file-store/API compatibility cases. |
| `tests/media-gallery-postgres.test.mjs` | Add 9 real PostgreSQL preservation, upgrade, rollback and conflict cases. |
| `package.json` | Include the new API cases and add `test:media-contract` / `test:media-schema`. |
| `docs/media-galleries.md` | Document payloads, filters, initialization and deployment ordering. |

## Compatibility decisions

- `title` is optional in stored items and old write payloads. Public/admin reads expose absent titles as `null`. Explicit null clears a title; omitted title preserves it. Non-null titles use the existing `{ en, zhHant, zhHans }` keys, each a string of at most 300 characters. Existing captions and alternative text retain their roles.
- Public GET keeps `{ items: [...] }`. Without a filter, it returns the original five galleries and the added `home-banner`. `?gallery=home-banner` is canonical; `gallery_id` is an alias. Invalid, empty, repeated and conflicting filters return 400. Public hidden-item filtering, admin authorization and the existing no-store headers remain in place.
- Existing photo/video payloads, operation fingerprints, replay status, optimistic versions, asset retention and translation provenance remain compatible.
- Initialization is based on a missing gallery, never on an empty items array. File initialization re-reads under the existing exclusive writer lock. SQL uses `ON CONFLICT DO NOTHING`. An administrator-cleared gallery stays empty on later reads, restarts and migration reapplication.
- The initial banner references `home.hero`; it does not copy or modify the hero asset. Custom image crop/alt settings resolve through the existing public media serializer, with the existing static classroom image as fallback.
- No homepage markup/CSS, admin title editor, CDN snapshot or broadcast mechanism was introduced in CP1.

## Resumed acceptance baseline — 2026-10-07

The current HEAD was read again: `fd6a93dd433da347ca4e5d412c25d6f5280fc57f`. The working tree had 19 modified/untracked entries; it was not clean, and all pre-existing work was retained. The recorded baseline is `output/cp1-pg-acceptance-2026-10-07/baseline.json`.

Migration 024 raw-byte SHA-256 and normalized migration checksum were both:

`2d7bd0f91bcd082abef6035c30a968663d843c4219c97bfe97dc9cd4f8253902`

This round changes only `tests/media-gallery-postgres.test.mjs` and this report. The test changes address concrete gaps: invoke the actual migration runner and verify its ledger transaction; prove simultaneous work on independent PG connections; reread all valid title variants; capture rollback/restart evidence; sanitize Docker failure messages and clean up the uniquely named test container even after a startup timeout. No production code, package scripts, migration SQL, homepage files or CP0 generator files were changed this round.

## Environment and isolation

The previous Docker failure record remains at `output/media-gallery-postgres/verification-blocked.json` as historical evidence. On this run, starting the existing Docker Desktop was sufficient; the old `dockerInference` failure did not recur. No settings changes, factory reset, pruning, disk deletion or image download were needed. Existing Docker workloads/data were retained.

- Docker Desktop `4.54.0.212467`; Docker client/server `29.1.2`.
- Actual SQL server: PostgreSQL `17.11`, `server_version_num = 170011`; the suite asserts major version 17.
- Existing image: `postgres:17-alpine`, digest `postgres@sha256:f02121de6f74d30d8a94cd1d9584125e2178d7e6c377d8130112d4e52d867995`.
- A unique disposable container bound PostgreSQL only to `127.0.0.1` on a generated port, without mounting host data volumes. Its baseline/upgrade/rollback databases all lived in that container.
- Real `lib/media-gallery-store.ts` was used with `IHEAR_FORCE_FILE_STORE=0` and explicit disposable DB URLs. Failed connections fail the suite; no file-store fallback, SQL mock or skipped PG case is used.
- The unchanged `scripts/migrate-database.mjs` ran as a child process from an isolated directory containing copied migration SQL and no `.env` files. Both DB URL variables were explicitly set to the disposable target. Neither passwords nor complete connection strings are included in evidence.

Environment evidence: `output/cp1-pg-acceptance-2026-10-07/environment.json`.

## Original nine tests and final coverage

The existing nine names were enumerated before running tests and retained. All nine executed and passed:

| Existing test name | Final coverage |
| --- | --- |
| `migration preserves every legacy gallery field, asset, operation and translation state` | Real runner bootstraps through 023, populates existing gallery data, upgrades to 024; compares complete old data, prior 23 ledger rows and allowed revision changes. |
| `actual PostgreSQL CHECK changes only gallery IDs and retains all previous constraints` | Reads actual definitions; accepts all six IDs; rejects invalid ID, negative version and non-array items; retains other constraints and RLS. |
| `seed references home.hero once and missing title reads as null without rewriting old JSONB` | Verifies the one-time seed and null read normalization without stored JSONB changes. |
| `a forced post-DDL failure rolls back the new CHECK, seed and all existing rows` | Actual runner fails at its 024 ledger INSERT; verifies full rollback and a successful retry after removing the test-only fault. |
| `existing migration 019 database retries a failed local upgrade and preserves an empty banner on restart` | Exercises the existing local store initialization entry, seed failure/retry and empty-banner restart. |
| `PostgreSQL put, lost response replay, changed replay and concurrent version conflicts remain compatible` | Independent clients/PIDs with simultaneous lock waits; one winner/409 loser; duplicate retry commits once; gallery UPDATE and operation INSERT roll back together on failure. |
| `multilingual title, move and remove preserve retained assets and provenance` | Verifies title/order/removal, retained assets and old operation/translation state. |
| `legacy payload omission preserves a saved title and explicit null clears it in PostgreSQL` | Rereads stored values after omission, explicit null and valid all-empty multilingual strings. |
| `reapplying migration preserves an administrator-cleared banner and every saved field` | Actual runner reruns skip 024; store restart keeps empty items, ledger and revisions unchanged. |

## Executed commands and results

`npm run test` runs API, operations and E2E; it does not include PG acceptance. Both commands were explicitly executed.

| Command | Passed / failed / skipped | Exit code | Evidence |
| --- | --- | --- | --- |
| `npm run test` — first attempt | API: 350 / 2 / 0; later stages not reached | 1 | `npm-test.log` |
| `npx --no-install vitest run tests/team-store-postgres.test.mjs tests/resource-topic-model.test.mjs` | 33 / 0 / 0 | 0 | `timeout-recheck.log` |
| `npm run test` — final rerun | API 352, operations 47, E2E 87: total 486 / 0 / 0 | 0 | `npm-test-retry.log` |
| `npm run test:media-schema` | 9 / 0 / 0 | 0 | `pg-acceptance.log` |
| `npm run content:check` | 293 logical slots / 13 pages verified | 0 | `content-check.log` |
| `npm run lint` | Passed | 0 | `lint.log` |
| `npm run typecheck` | Passed | 0 | `typecheck.log` |
| `npm run build` | Passed production compilation, TypeScript and page generation | 0 | `build.log` |

Command logs are under `output/cp1-pg-acceptance-2026-10-07/`. The first full attempt hit existing 5-second test timeouts during Docker startup. Those same 33 cases passed in isolation without code changes, and the full rerun passed after startup. No timeout limits in those existing tests were changed.

Final repository/cleanup evidence is `output/cp1-pg-acceptance-2026-10-07/final.json`: all 24 migration files (including 024) retain their starting bytes/checksums, all pre-existing CP0/product changes are preserved, and the dedicated test container has been removed. The prior unfiltered GET, gallery/video and operation-status API contracts remain covered by the passing API suite.

## Actual PostgreSQL evidence

Evidence directory:

`output/media-gallery-postgres/ihear-media-contract-350038be-c53e-4022-9b54-2829ea1e571d/`

`preservation.json` contains actual server identity, runner results, complete old gallery/item/video/ordering data, retained assets, operations, site-media assets/variants, translation state, constraints, migration ledger and revisions. JSONB is compared structurally with array order preserved. The old-data snapshot SHA-256 before and after is identical:

`b4308a7ac915da8ff10a7c7f02c3bd12de76725dbf1c8c9a76c8774cef5389bf`

Only these upgrade differences are allowed: one new `home-banner` row, one 024 ledger row, the existing trigger's content revision increment of one (and its timestamp), and the expanded ID CHECK. The 23 prior migration ledger rows and all old snapshot values are equal. Other revision scopes are unchanged.

Actual `media_galleries_id_check` before:

```sql
CHECK ((id = ANY (ARRAY['tutoring'::text, 'outreach'::text, 'home'::text, 'stories'::text, 'impact'::text])))
```

After:

```sql
CHECK ((id = ANY (ARRAY['tutoring'::text, 'outreach'::text, 'home'::text, 'stories'::text, 'impact'::text, 'home-banner'::text])))
```

The primary key, `version >= 0`, and array/20-item CHECK definitions are unchanged; RLS remains enabled.

`concurrency.json` records real backend PIDs 72 and 73 simultaneously waiting on database locks. One operation committed, one rejected with 409; the gallery version increased once, the old video remained, and only the winning operation record exists. PIDs 76 and 77 tested simultaneous identical operation IDs: exactly one commit and one replay, one saved item and one operation row. A separate injected operation-log failure proves the gallery update and operation record remain atomic.

`runner-rollback.json` records the actual runner's deliberate `P0001` failure at the 024 ledger INSERT, with exit code 1. The transaction left the old CHECK, data, revisions and all 23 ledger rows unchanged, with no Banner seed or 024 row left behind. Removing that test-only trigger and retrying exited 0 and applied only 024.

`title-roundtrip.json` records persisted title preservation after omission, explicit null, and `{ en: '', zhHant: '', zhHans: '' }`. `empty-banner-restart.json` records empty items after actual runner reruns and store reinitialization, with unchanged migration ledger and revisions.

## Recovery boundary and remaining scope

The verified rollback is failure before transaction commit, using the actual runner boundary that includes migration SQL and its ledger INSERT. A committed migration is not undone by removing its ledger row or narrowing the CHECK: that could strand or destroy subsequently created Banner data. Recovery after commit requires a reviewed forward repair, or restoration of a verified backup into a separate database followed by reconciliation of newer writes. No destructive down migration or committed-data restoration was performed or claimed as tested.

CP1's required PG acceptance is complete. No deployment database was contacted or upgraded. Production rollout still requires backup/preservation checks and migration 024 before the code deploy; this run does not establish the schema or data state of a deployment database. Media admin UI, homepage SSR/controller, announcement/calendar cards and deployment remain outside this checkpoint. No next checkpoint was started.
