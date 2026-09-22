# Checkpoint 7 — STOP at isolated PostgreSQL schema-suite setup

## Changed files

- `docs/resource-topics-checkpoint-7.md`: this release-gate report.
- `output/checkpoint-7/`: command logs, isolated generator copy/output, actual and
  baseline source copies, unified diffs, field-level comparisons and machine-readable
  release-gate summary. These are local audit artifacts, not application changes.

No application, migration, schema, content source or test implementation was
modified. Earlier checkpoints' existing working-tree changes were left intact.

## What was implemented

Validation only. No new feature, requirement or bug fix was implemented.
Validation stopped at the first integration-suite failure. There was no automatic
retry, no flaky-test exception and no continuation into browser/build stages.

## Tests executed + results

| Actual command | Observed result |
| --- | --- |
| `npm run content:check` | FAIL: four stale artifacts; fully investigated as baseline-only below |
| `node output/checkpoint-7/compare-content.mjs` | PASS: isolated generator output captured, hashes compared to accepted CP4 artifacts |
| `node output/checkpoint-7/compare-hunks.mjs` | Completed raw changed-line comparison; catalog/inventory needed field-level comparison because accepted Resources metadata changes affect diff context |
| `node output/checkpoint-7/compare-semantic.mjs` | Catalog: 164 current field differences, all present in baseline; inventory whole-row comparison refined below |
| `node output/checkpoint-7/compare-inventory-fields.mjs` | PASS: 164 inventory field differences, all present in baseline; no new field-value difference |
| `npm run lint` | PASS, exit 0 |
| `npm run typecheck` | PASS, exit 0 |
| `git diff --check` | PASS, exit 0; CRLF notices only |
| `npm run test:api` | PASS: 20 files, 324 tests |
| `npm run test:operations` | PASS: 2 files, 25 tests |
| `npx vitest run tests/resource-guide-takeover.test.mjs tests/restore-comparison.test.mjs` | PASS: 2 files, 11 tests |
| `npx vitest run tests/resource-topic-api-postgres.test.mjs tests/resource-topics-postgres.test.mjs` | FAIL overall: API file 45 passed; schema file failed during beforeAll, 32 tests skipped |

The database-related commands unset inherited `POSTGRES_URL` and `DATABASE_URL`.
PostgreSQL integration tests use uniquely named disposable containers with locally
generated configuration, not production database credentials.

### Stopping failure

`tests/resource-topics-postgres.test.mjs:34` failed while applying historical schema
in its `beforeAll`, before its 32 assertions and before executing Migration 023:

```text
psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed:
FATAL: the database system is shutting down
```

Actual container: `ihear-resource-schema-bc31da8d-496e-4982-8147-a7edee7c91da`.
See `output/checkpoint-7/postgres-integration.log` for the unmodified failure output.

Static inspection shows readiness is inferred from a single successful Unix-socket
`SELECT 1`, followed immediately by setup migrations. A startup readiness race is
plausible; this run did not retain PostgreSQL startup logs, so the exact shutdown
cause is NOT proven. Do not label this an application-data regression or assume it
is harmless. No retry or fix was made after the failure.

## Regression / baseline comparison

Baseline commit: `5706e268015eebd421ce5d3e5af2ac261d944e6a`, as recorded by CP4.
Generation ran with `--write` ONLY inside `output/checkpoint-7/catalog-current`,
never against source-controlled content. The actual `content:check` remains FAIL.

| Artifact | Actual comparison |
| --- | --- |
| `index.html` | Both source and generated SHA-256 exactly match the accepted CP4 fingerprints. One changed line only: order of `data-gallery-section` / `data-layout-section="home.video"` attributes. |
| `stories.html` | Both hashes exactly match CP4. One changed line only: order of the corresponding `stories.video` attributes. |
| `data/content-slots.json` | Generated output exactly matches accepted CP4 output. 164 current occurrence-field differences are all identical to baseline differences; no new field values. 36 baseline differences were already removed by accepted Resources metadata work. |
| `docs/content-slot-inventory.md` | Generated output exactly matches accepted CP4 output. Comparing each field and each file's occurrence location finds 164 existing differences, zero new differences; 35 baseline field differences were already resolved. |

Inventory whole-line comparisons initially differ because shared rows include
Resources locations already updated in CP4. The saved per-cell/per-file comparison
proves that the outstanding before/after differences are the old occurrence-line
changes, not new content or translation drift. This is not a filename exemption.

Audit evidence:

- `content-check.log`: actual failing command output.
- `content-comparison.json`: source/generated hashes and accepted CP4 output hashes.
- `content-diffs/*.diff`: complete current source-to-generated unified diffs.
- `content-hunk-comparison.json`: raw changed-line evidence, including nonmatching
  whole-line cases; preserved rather than discarded.
- `content-semantic-comparison.json`: exact catalog field changes and final
  `noNewDifferences: true` after inventory refinement.
- `inventory-field-comparison.json`: exact inventory field/occurrence comparisons.

The existing `site.js` change was inspected read-only: it excludes links inside
`.admin-app` from the global external-link decoration. Runtime cross-page link
regression was NOT executed because validation stopped before browser testing.

## Data/schema implications

No production connection or production data/schema change. No production migration
or Guides takeover was run. Integration setup wrote only disposable local test
databases. Source HTML/catalog files were not regenerated or overwritten.

## Known issues / unresolved questions

1. PostgreSQL schema test setup failure is unresolved. Its 32 skipped tests are
   unverified, not PASS. Investigate stable database readiness and retain container
   startup logs after Review before rerunning.
2. `content:check` remains FAIL with verified existing drift; artifacts were not
   silently refreshed and this gate was not reported as clean.
3. Not run in CP7 because of STOP: complete Playwright/E2E, Admin Resources smoke,
   Public Resources smoke, post-takeover browser checks, three-language/fallback,
   anchor/mailto browser verification, 320/390/desktop, keyboard accessibility,
   full-site link regression and production build. CP6 results are historical
   evidence and do not substitute for CP7 runs.

## Release readiness

**NOT READY — CHECKPOINT 7 STOPPED.** Passing earlier tests does not clear the
release gate. The integration setup failure and remaining validations require
Review and completion before any commit, push or deployment.

## No production changes performed

No production changes, commit, push, deployment or release action. No automatic
fix/retry after the integration failure. Await final Review/instructions.

## Subsequent authorized Schema-only remediation — 2026-09-22

After the STOP above, a separately authorized investigation reproduced the
temporary-server socket readiness race with no schema SQL. The Schema test now
uses container-local TCP; three fresh reruns passed all 33 tests. The final run
also confirmed graceful container cleanup (exit 0). Full evidence and limitations
are in [postgres-schema-readiness-investigation.md](postgres-schema-readiness-investigation.md).

This clears only the investigated Schema startup issue. **Checkpoint 7 remains
stopped for Review**; none of the remaining release-gate checks have resumed.
