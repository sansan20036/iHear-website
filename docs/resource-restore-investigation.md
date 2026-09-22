# Checkpoint 6 restore investigation — clean restore, awaiting review

## Scope and outcome

Only the existing backup's isolated restore and comparison were investigated.
No production connection, Migration 023, Guides takeover, commit, push, deployment
or Checkpoint 7 work occurred. Both disposable containers were removed.

The previous mismatch is proven to be representation-only. There are two raw
representation differences: bigint string versus JSON number, and timestamp text
formatting. PostgreSQL compares all five revision values and timestamps equal,
including microsecond precision. The previous comparator already normalized the
timestamps, leaving the bigint representation as the cause of its failure.

The from-scratch corrected validation passed **all 20 tables / 2,716 rows**,
including empty tables. Earlier prose said 21 tables; that was a counting error,
not a missing table. The snapshot manifest and both restore runs contain 20.

## Changed files

* `scripts/investigate-resource-restore.mjs`: diagnostic / restore-validation-only
  runner; persists raw, parsed, lossless and SQL-proof artifacts before checking.
  It only builds the recorded 001–022 schema and has no 023/takeover execution path.
* `scripts/restore-comparison.mjs`: schema-aware, precision-safe comparison.
* `scripts/rehearse-resource-migration.mjs`: uses the corrected restore comparator,
  saves raw output/diffs, and now stops after restore by default. Migration requires
  an explicit --allow-migration option after review. This runner was not executed
  during the investigation.
* `tests/restore-comparison.test.mjs`: six regression tests for normalization and
  detecting genuine differences.
* `docs/resource-topics-checkpoint-6.md`: link to this follow-up and table-count correction.
* `docs/resource-restore-investigation.md`: this audit report.

## Source and evidence

Source: `backups/resource-rehearsal-2026-09-21T17-43-45-591Z.json`.
Payload SHA-256: `bc5d93a775743ae52a87a079ca1c2c7754c301d8026b411c9e2f786f657479e1`.
The backup's entire file hash was checked before and after each run; unchanged.

Diagnostic directory:
`output/checkpoint-6-restore/5afd7730-ecc6-4ab6-9954-c58420970ee7/`

* `site_content_revisions.before.json`: original snapshot rows.
* `site_content_revisions.actual.raw.json`: exact PostgreSQL JSON tokens.
* `site_content_revisions.actual.parsed.json`: JavaScript-parsed values.
* `site_content_revisions.sql-proof.json`: exact decimal revisions, UTC timestamps,
  epoch microseconds and typed SQL equality results for every key.
* `site_content_revisions.diff.json`: field presence, exact values, runtime and
  serialized types, SQL type/equality, missing/extra/duplicate keys and ordering.
* `report.json`: execution scope, backup identity and artifact SHA-256 checksums.

Fresh validation directory:
`output/checkpoint-6-restore/6f70fc17-c778-49ec-b118-8e723c5358fd/`

Contains the same target-table evidence plus raw JSON, lossless JSON and comparison
artifacts for **every restored table**, and `report.json` with all 20 comparisons,
88 successful checks and checksums. No failing table was discarded without output.
These private backup-derived artifacts remain in ignored output directories.

## Field-level comparison of every differing row

Primary key: `scope`. Row count: **5 before, 5 after**. No missing keys, extra keys
or duplicate keys on either side. The scope values are identical strings.

Every revision is SQL bigint/int8. Before: JS string / JSON string. After parsing
the original SQL JSON: JS number / JSON number. Exact PostgreSQL decimal text
agrees in every case:

| scope | before JSON value | after JSON value | typed SQL value equal |
|---|---|---|---|
| content | `"2386"` | `2386` | true |
| impact | `"393"` | `393` | true |
| layout | `"5"` | `5` | true |
| team | `"2648"` | `2648` | true |
| theme | `"20"` | `20` | true |

Every updated_at is SQL timestamptz, JS string / JSON string on both sides:

| scope | exact before value | exact after value | UTC value on both sides (microseconds) |
|---|---|---|---|
| content | `2026-09-21T17:02:49.510Z` | `2026-09-21T17:02:49.51+00:00` | `2026-09-21T17:02:49.510000Z` |
| impact | `2026-09-21T15:33:26.338Z` | `2026-09-21T15:33:26.338+00:00` | `2026-09-21T15:33:26.338000Z` |
| layout | `2026-08-23T13:49:30.266Z` | `2026-08-23T13:49:30.266+00:00` | `2026-08-23T13:49:30.266000Z` |
| team | `2026-09-21T12:50:17.784Z` | `2026-09-21T12:50:17.784+00:00` | `2026-09-21T12:50:17.784000Z` |
| theme | `2026-09-19T20:27:47.639Z` | `2026-09-19T20:27:47.639+00:00` | `2026-09-19T20:27:47.639000Z` |

UTC Z and +00:00 represent the same offset. Trailing fractional zero removal is
formatting, not precision loss. Typed SQL `IS NOT DISTINCT FROM` and epoch
microsecond values agree for every row. No null, undefined, missing-property or
empty-string difference exists. Target row ordering and object-key ordering also
match; whitespace/pretty-print formatting is not a data-value difference.

Therefore, **the raw output is not different only in bigint type**: timestamp
formatting also differs. All differences are proven to preserve the actual value.

## Comparison correction

Only schema-declared int8 and timestamptz fields receive transport normalization.
Int8 uses exact decimal BigInt conversion, never lossy Number coercion; unsafe
numeric transport is rejected. Fresh validation casts int8 to decimal text before
JSON.parse and also preserves the original unmodified numeric-token JSON.
Timestamps compare exact epoch microseconds and timezone offsets without truncating
to JS Date's millisecond precision. Unsupported formats fail closed.

Primary keys align rows independently of query order. Object-key order is ignored;
nested JSON-array order remains significant. Null, absent and empty-string values
are distinct. Missing/extra rows and duplicates fail validation. No blanket string
coercion, all-array sorting or ignoring changed fields was added.

## Tests executed + results

PASS:

```powershell
node scripts/investigate-resource-restore.mjs backups/resource-rehearsal-2026-09-21T17-43-45-591Z.json --diagnose
node scripts/investigate-resource-restore.mjs backups/resource-rehearsal-2026-09-21T17-43-45-591Z.json --validate-restore output/checkpoint-6-restore/5afd7730-ecc6-4ab6-9954-c58420970ee7
npx vitest run tests/restore-comparison.test.mjs
npx eslint scripts/investigate-resource-restore.mjs scripts/restore-comparison.mjs scripts/rehearse-resource-migration.mjs tests/restore-comparison.test.mjs
node --check scripts/investigate-resource-restore.mjs
node --check scripts/rehearse-resource-migration.mjs
git diff --check
```

Diagnostic result: REPRESENTATION_ONLY. Fresh container result:
RESTORE_VALIDATED_AWAITING_REVIEW; 20/20 tables, 2,716/2,716 rows, zero real value
changes, missing rows or duplicate primary keys. All 6 comparator tests passed,
including beyond-safe-integer values, a real 1-microsecond change, null/empty/missing,
JSON-array order, duplicate/missing keys and non-schema string/number differences.
Two promise-executor lint findings were fixed; targeted lint then passed.

## Data/schema implications and limitations

No production data/Schema or application behavior changed. Only disposable restore
databases and local evidence files were written. This proves fidelity to the saved
backup, not to any unrecorded precision or later edits in the live database. The
backup was reused deliberately to reproduce the stopped run; no new production
snapshot was taken. Future migration should obtain a new snapshot when authorized.

No unresolved discrepancy remains in the restored snapshot. Migration 023, Guides
takeover, migration idempotency, migration rollback and post-takeover rendering are
still unexecuted/unaccepted. These restore results do not complete Checkpoint 6.

## No work performed beyond the authorized investigation

STOP. Await Review before any Migration 023 or Guides takeover. No Checkpoint 7.
