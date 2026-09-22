# Checkpoint 6 — Public takeover repaired; rehearsal PASS, awaiting Review

## Current result (2026-09-22)

The authorized public-rendering repair and a fresh isolated rehearsal are complete.
**STOP for Review; do not enter Checkpoint 7.** No production connection or writes,
commit, push or deployment. Older stopped runs are preserved below for audit.

### Changed files

Only the following files were changed in this continuation (other worktree changes
belong to earlier checkpoints):

| File | Purpose |
| --- | --- |
| `lib/resource-guides-takeover.ts` | Read-only marker/record consistency policy; no migration writes |
| `lib/resource-store.ts` | Read marker and full record identities from the same SQL snapshot; equivalent file-mode policy |
| `app/api/resources/route.ts` | Return explicit public takeover state; 503 for inconsistent state |
| `assets/resources.js` | Select one renderer, remove legacy DOM after takeover, fail closed, reject duplicate IDs and stale pre-takeover responses |
| `resources.html` | Keep all legacy content, initially hidden pending authoritative state |
| `assets/site.css` | Enforce pending legacy visibility without changing content |
| `scripts/prepare-public.mjs` | Bump Resources script version to v3 |
| `tests/resource-guide-takeover.test.mjs` | File-store API and consistency tests using synthetic fixtures |
| `tests/resource-topic-api-postgres.test.mjs` | Actual PostgreSQL API marker/visibility tests |
| `tests/resource-takeover-render.smoke.mjs` | Three-language current-script browser checks and recovery presentation checks |
| `scripts/rehearse-resource-migration.mjs` | Fresh restore, audit artifacts, isolated admin-edit clone, actual pg_dump/restore and added-record recovery checks |
| `docs/resource-topics-checkpoint-6.md` | This report and bounded recovery procedure |

### What was implemented

- Existing SQL marker `resource_guides_takeover_v1=complete` / file marker
  `legacyGuidesMigrated=true` authorizes takeover. No new persisted marker/schema.
- No marker plus no migrated Guide records is the valid pre-takeover state.
  Pre-takeover public content, three-language titles, ordering and unified legacy
  Email CTA remain unchanged once the public snapshot is loaded.
- A missing marker with migrated records, invalid marker, missing expected Guide
  identity or missing parent is inconsistent. The public API returns 503; the
  page displays its translated retry error and shows neither set of Guides.
- Complete-state consistency uses all records, including draft/archived ones.
  Hiding or archiving the new Guides does not reactivate old content. Later valid
  title/type/order/move edits are not overwritten or used to infer takeover.
- After takeover, remove the legacy section from the current DOM and render the
  new public Items once. Refresh failures or stale legacy responses cannot bring
  back that removed section. Stored legacy data and the source HTML remain intact.

### Tests executed + results

| Executed command | Result |
| --- | --- |
| `npx vitest run tests/resource-guide-takeover.test.mjs tests/resource-topic-api.test.mjs` | PASS, 47 tests |
| `npx vitest run tests/resource-topic-api-postgres.test.mjs` | PASS, 45 tests, disposable loopback-only PostgreSQL |
| `node tests/resource-takeover-render.smoke.mjs output/checkpoint-6-render-fix` | PASS, 19 browser scenario groups |
| `npx tsc --noEmit --incremental false` | PASS after correcting the new SQL query result type annotations |
| `npx eslint assets/resources.js scripts/prepare-public.mjs scripts/rehearse-resource-migration.mjs tests/resource-guide-takeover.test.mjs tests/resource-topic-api-postgres.test.mjs tests/resource-takeover-render.smoke.mjs` | PASS after correcting a test promise executor; TypeScript is checked separately because repository ESLint excludes it |
| `git diff --check -- app/api/resources/route.ts lib/resource-store.ts assets/resources.js assets/site.css resources.html scripts/prepare-public.mjs` | PASS |
| `node scripts/rehearse-resource-migration.mjs backups/resource-rehearsal-2026-09-21T17-43-45-591Z.json --allow-migration` | Final fresh run PASS, 95 backend/data/recovery checks; embedded browser checks PASS, 20 groups |

Final run directory: `output/checkpoint-6/30a1324c-2815-4132-9d51-99f0caf83df3/`.
The browser driver runs once before recovery and again with `--recovery` after
restore. It uses actual current HTML/site.js/resources.js with intercepted local
public snapshots and the backup's localization values. It does not contact a live
Next server or production. Actual API handlers are tested separately on file/SQL.

An earlier attempt in `10a0f2b8-ac25-4e69-83b6-998e7f4d08a0` stopped after 80 passing
checks: the newly authored recovery fixture omitted required Item `description`.
The SQL constraint correctly rejected that synthetic row. Only that test fixture
was corrected; a NEW container restored the same accepted backup from scratch.
The failed report is retained, not relabeled PASS. The final run's `sql-failure.json`
is the expected negative test rejecting archive of a nonempty Topic, not a failed
migration or an unexplained difference.

### Data/schema implications

The repair itself adds no tables, columns, migrations or persisted data. It only
reads the existing marker and identities. Migration 023 and Guide migration logic
were not changed; SHA-256 remains:

- `023_resource_topics.sql`: `0ab4dbd9d6c98b486ef008a63a82a0346634bec1bdbf3cc88417d1df640dcfe1`
- `resource-guide-takeover.mjs`: `de8b983ce10523fc26b7b55b2c151c0ea83479d7750d199e885c14c526b10f2b`

The fresh networkless, portless Docker restore used the accepted frozen production
backup from `2026-09-21T17:43:45.591Z`; no new production snapshot was fetched.
All 20 original tables passed exact schema-aware restore comparison. Isolated
migration results: 7 Topics, 14 Items (5 original Forms, 9 email_request Guides;
zero original Articles). Original content, URLs, status, translations and order
passed comparison; the nine source-to-target field comparisons are saved.

Expected row additions only: resource_topics +7, resource_links +9,
localized_translation_states +34, site_settings +1. Existing translation rows and
legacy Guide content are retained. Content revision counters change through
existing triggers. Migration SQL is executed directly here; the production runner
and its migration ledger are not invoked (the copied ledger remains at 22 rows).

Idempotency repeats preserve all data and later administrator edits. Synthetic
administrator edits happen ONLY in a separate `admin_simulation` database clone;
the primary migrated nine Guides are checked unchanged after simulations.

### Rollback/recovery procedure and evidence

The bounded recovery strategy tested here is:

1. Freeze management writes before switching to an emergency read-only snapshot
   presentation. Keep the upgraded authoritative database and its added data.
2. Preserve an upgraded `pg_dump`; restore it into a separate fresh database.
   Do not drop the new tables/columns or replace the authoritative database with
   the pre-migration backup.
3. For temporary previous public behavior, use the pre-migration snapshot with
   the compatible read-only presentation: five original links + nine old Guides.
   This is a frozen historical view; subsequent updates remain retained in the
   upgraded database. Admin writes must stay disabled during this mode.
4. Resume the compatible upgraded presentation from the retained/restored data.
   Confirm the takeover marker, added records and current hiding are honored.

Actual `pg_dump` and independent restore preserved all 21 upgraded tables with
zero data differences, including a newly added Topic/Item and simulated manual
edits. The recovered public projection shows the added item, respects the hidden
Guides Topic and never revives legacy Guides. SQL transaction rollback also passed.
This is NOT permission or evidence to deploy the unmodified old writable app
against upgraded data. Production traffic switching and an old application binary
rollback were not exercised.

Machine-readable artifacts in the final run directory:

- `report.json`, `checkpoint-summary.json`, `schema-after-023.json`.
- `before-migration.json`, `after-023.json`, `after-takeover.json`, `row-counts-before-after.json`.
- `guide-comparison.json`, `guide-field-comparison.json`, `guide-plan.json`.
- `idempotency-before.json`, `idempotency-after.json`, `admin-edits-before-rerun.json`, `admin-edits-after-rerun.json`.
- `takeover-render-report.json`, `takeover-pre-dom.html`, `takeover-post-dom.html`, corresponding public payloads.
- `recovery-upgraded.sql`, `recovery-before.json`, `recovery-after.json`, `recovery-diff.json`, `rollback-simulation-results.json`.
- `rollback-retained-resource-links.json` and per-table raw restore/diff artifacts.

### Known issues / unresolved questions

No remaining duplicate-rendering or migration data mismatch was found. Presentation
requires a successful public-state read: while JavaScript/API is unavailable,
legacy content stays hidden rather than guessing a migration state. Production
routing, real devices/mail clients, full application regression and deployment
remain untested in this checkpoint. The snapshot recovery presentation is a local
simulation, not a production rollback switch. The CP7 baseline-aware content check
and shared site.js link regression checklist remain outstanding as agreed.

### No work performed beyond this checkpoint

No production access or data/schema modification, no legacy-data deletion, no
changes to Migration 023 or the Guide importer, no commit/push/deploy, no CP7.
**STOP and await explicit Review.**

---

## Historical result — duplicate rendering (repaired above)

## Latest review (2026-09-22, after restore validation acceptance)

**Overall result: STOP.** Migration/takeover data checks passed, but the isolated
public renderer displays nine migrated Guides AND nine legacy Guides (18 rows).
No repair or further migration/recovery tests were run after detecting this failure.

### Changed files in this continuation

- `scripts/rehearse-resource-migration.mjs`: use microsecond-accurate timestamp
  comparison, preserve nested JSON array order, save raw before/after, SQL failure,
  guide comparison, rerun and administrator-edit evidence.
- `tests/resource-takeover-render.smoke.mjs`: isolated Chromium diagnostic using
  the migrated fixture and current Resources HTML/CSS/renderer. All requests are
  intercepted; no production access, live API or Next server is used.
- This report; generated evidence under the run directory and Playwright output.

### Commands and observed results

1. `node scripts/rehearse-resource-migration.mjs backups/resource-rehearsal-2026-09-21T17-43-45-591Z.json --allow-migration`
   — PASS, exit 0, 89 backend/data checks, disposable networkless PostgreSQL 17.
2. `node tests/resource-takeover-render.smoke.mjs output/checkpoint-6/fd0bb2dc-2fa1-4817-8d80-800588eaf8f1`
   — FAIL / STOP, exit 1, expected 9 visible Guides, actual 18.

The 89 checks do not constitute full Checkpoint 6 acceptance. They include exact
restore of all 20 snapshot tables, preservation of all original five Forms and
translation rows (there are zero original Articles), nine per-Guide checks,
PostgreSQL/file semantic parity, repeated migration/takeover and administrator-edit
preservation, FK/archive restrictions and published/draft archive restoration.

### Data/schema implications

Migration 023 and takeover ran only in the disposable restored database. Final
takeover state: 7 Topics, 14 Items, including exactly 9 Guides, all `email_request`.
Available three-language titles, source translation states and ordering passed
comparison. Original five Forms retain their fields/URLs/order/status. A synthetic
hidden legacy section maps to a draft Topic without changing child publication.

Takeover records `site_settings.resource_guides_takeover_v1=complete`; file mode
records `legacyGuidesMigrated=true`. These flags are not consumed by the existing
public pipeline. No production data/schema was changed. No new migration/schema
definition was authored in this continuation. The SQL runner executes migration
text directly; production migration-runner ledger integration is not tested here.

### Blocker and remaining recovery limitations

`lib/resource-store.ts` and `/api/resources` return only Topics/Items. The public
renderer adds migrated Guides but does not remove the static
`[data-resource-legacy-guides]` section in `resources.html`. Browser evidence
confirms all nine old rows remain visible alongside the nine new rows. This is
duplicate presentation, not duplicate database insertion.

Recovery checks completed BEFORE this failure only demonstrate SQL transaction
rollback and a PostgreSQL `CREATE DATABASE ... TEMPLATE` copy retaining migrated
data and administrator edits. The backend report label "Full upgraded backup/restore"
is broader than its actual test: this was a database clone, NOT pg_dump/restore
and NOT a previous-version application rollback. End-to-end application recovery,
old-version public behavior and new post-migration administrator-created records
have not been validated. Do not mark rollback/recovery acceptance complete.

### Evidence

Run directory: `output/checkpoint-6/fd0bb2dc-2fa1-4817-8d80-800588eaf8f1/`

- `report.json`: backend-only PASS and 89 checks; overall checkpoint remains STOP.
- `before-migration.json`, `after-023.json`, `after-takeover.json`.
- `guide-plan.json`, `guide-comparison.json`, `postgres-resource-document.json`.
- `idempotency-before.json`, `idempotency-after.json`.
- `admin-edits-before-rerun.json`, `admin-edits-after-rerun.json`.
- `rollback-retained-resource-links.json`, `rollback-simulation-results.json`.
- `takeover-render-report.json`: nine matching duplicate pairs, source hashes.
- `takeover-public-payload.json`, `takeover-public-dom.html`.
- `checkpoint-summary.json`: overall STOP, backend PASS, renderer FAIL.
- Screenshot: `output/playwright/checkpoint-6-guide-takeover.png`.

### No work performed beyond this checkpoint

No production connection, production data/schema writes, commit, push, deployment
or Checkpoint 7 work. No application fix was applied after the failure. Await Review.

---

## Historical report — initial restore mismatch (subsequently resolved)

Follow-up: [restore investigation](resource-restore-investigation.md) proves the
representation-only mismatch and records a clean fresh restore. Checkpoint 6 is
at that time was stopped for review, before 023 and Guides takeover were executed.

## Changed files

* `scripts/snapshot-resource-rehearsal.mjs`: creates a new local snapshot of all
  public tables plus column/constraint metadata. The production connection has
  default_transaction_read_only=on and uses a REPEATABLE READ READ ONLY transaction.
  Only SELECT/SHOW are issued; output excludes credentials and row contents.
* `scripts/resource-guide-takeover.mjs`: offline draft converters and guide import
  plan/SQL. Intended to preserve source text, ordering and translation provenance,
  create nine email_request entries and record a persistent takeover marker.
  **Not executed or accepted in this rehearsal.**
* `scripts/rehearse-resource-migration.mjs`: validates a supplied snapshot, restores
  it into a unique PostgreSQL Docker container with no network/ports/host mounts,
  and checks preservation before attempting 023. Fails closed on the first
  failed check. Later takeover, parity, rerun and rollback checks were not reached.
* `docs/resource-topics-checkpoint-6.md`: this stop report.

No application/API/UI/schema files changed in Checkpoint 6.

## What was implemented

A latest consistent snapshot was captured at 2026-09-21 17:43:45 UTC
(2026-09-22 01:43:45 Asia/Taipei).

Local ignored backup:
`backups/resource-rehearsal-2026-09-21T17-43-45-591Z.json`

SHA-256 payload checksum:
`bc5d93a775743ae52a87a079ca1c2c7754c301d8026b411c9e2f786f657479e1`

It contains 20 public tables, including 5 Forms, 0 Articles, 27 localized values
for the nine Guides, 1,255 translation-state rows and the 22 recorded migrations.
The new resource_topics table is absent, as expected before 023.

An isolated database was built with migrations 001–022, populated with the
snapshot and compared against it. The run stopped at site_content_revisions.
Migration 023 and guide takeover were **not executed**. The container was stopped
and automatically removed in the runner's finally block. The original backup
remains available; no in-place backup rewrite occurred.

## Tests executed + results

* PASS — `node scripts/snapshot-resource-rehearsal.mjs`: new consistent read-only
  snapshot created with checksum and counts; transaction read-only mode checked.
* FAIL / STOP — `node scripts/rehearse-resource-migration.mjs backups/resource-rehearsal-2026-09-21T17-43-45-591Z.json`
  — exit 1, 37 preliminary checks passed, then
  `Exact isolated restore: site_content_revisions` failed.
* The 37 passing checks comprise snapshot preconditions, 22 historical migration
  checksums, container readiness and exact restored comparison for 13 tables.
  They are not 37 completed migration/takeover acceptance tests.
* The matching tables include resource_links, localized_content_overrides and
  localized_translation_states. Remaining tables after the failed table were
  not compared because the loop stopped immediately.

Machine-readable execution evidence:
`output/checkpoint-6/fbe278be-3e22-4a75-ac92-69abffe0b521/report.json`

Post-stop static/cleanup checks only:
* PASS — `node --check scripts/snapshot-resource-rehearsal.mjs`.
* PASS — `node --check scripts/resource-guide-takeover.mjs`.
* PASS — `node --check scripts/rehearse-resource-migration.mjs`.
* PASS — `git diff --check`.
* PASS — `docker ps -a --filter label=ihear-test=resource-rehearsal --format '{{.Names}}'`
  returned no remaining rehearsal containers.

No rerun, automatic repair, Migration 023, guide takeover, browser takeover check,
idempotency check, cross-backend parity check or rollback simulation was performed
after the failure. These later operations remain unverified.

## Data/schema implications

Production data and production Schema were not modified. All writes targeted a
networkless disposable container. No changes were made to Migration 023 itself.
The draft guide importer uses a proposed site_settings marker and a corresponding
file-document property; neither was applied. Public rendering has not yet been
connected to that marker, so duplicate-rendering acceptance remains pending.

## Known issues / unresolved questions

The failing comparator sees site_content_revisions as unequal. Read-only review
of the saved backup confirms revision is PostgreSQL bigint/int8 and the snapshot
driver serialized its values as strings:

| scope | snapshot revision | JSON type |
|---|---|---|
| content | 2386 | string |
| impact | 393 | string |
| layout | 5 | string |
| team | 2648 | string |
| theme | 20 | string |

The isolated query uses json_agg followed by JSON.parse; the comparator normalizes
timestamp formats but not numeric representations. A bigint string/number
representation mismatch is therefore a plausible cause. **It is not proven that
data was lost, nor proven that serialization is the only difference.** The runner
did not save the failing table's actual row snapshot before container cleanup,
so an exact column-level before/after diagnosis is still outstanding.

Before another rehearsal, retain failing source/actual rows as private evidence
and compare bigint values without lossy JavaScript Number coercion. Do not waive
the check or mark migration accepted based on the likely explanation. Resumption
and repair await user review under the explicit STOP instruction.

The nine-guide reconciliation, type/status mapping, no-duplicate-rendering,
PostgreSQL/file parity, rerun/admin-edit preservation, FK/archive checks and
rollback/restore remain pending. Earlier Checkpoint 7 baseline-aware content:check
and shared site.js regression requirements are still in force.

## No work performed beyond this checkpoint

Checkpoint 6 is **not complete**. STOP at the failed isolated restore check.
No Checkpoint 7, production migration, commit, push or deployment was performed.
