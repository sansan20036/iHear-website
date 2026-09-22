# PostgreSQL Schema initialization remediation — 2026-09-22

Checkpoint 7 remains STOPPED. This report covers only the authorized Schema-test
infrastructure investigation. Times below are UTC (local time is UTC+8).

## Root cause

The Schema test's readiness query used `psql` without a host. Inside the official
`postgres:17-alpine` container this connects through the Unix socket, including
to the **temporary initialization server**. That server accepts queries before
the image entrypoint intentionally shuts it down and starts the final server.
A successful `SELECT 1` on that temporary server therefore does not mean the
final PostgreSQL instance is ready. The next query can receive:

`FATAL: the database system is shutting down`

This is a test readiness race, not evidence that Migration 023 terminates
PostgreSQL. A read-only probe reproduced the exact error with **zero schema or
migration statements**, after which the same container started normally.

The minimal connection fix is `psql -h 127.0.0.1` for both readiness and subsequent
Schema queries. The image's temporary server uses `listen_addresses=''`; only
the final server accepts container-local TCP. No arbitrary startup sleep was added.

## Evidence

All evidence is retained under `output/postgres-schema-investigation/`.
`summary.json` indexes each run and records artifact hashes. Each container's
directory includes complete PostgreSQL stdout/stderr logs, full Docker inspect,
state summaries before cleanup and after stop, and a UTC JSONL command timeline
with exit status, output, and SQL input hashes. The probe and standalone control
also retain `investigation.json` and the actual image's `docker-entrypoint.sh`.

Image used throughout: `postgres:17-alpine`, PostgreSQL 17.11,
`sha256:f02121de6f74d30d8a94cd1d9584125e2178d7e6c377d8130112d4e52d867995`.

### Reproduction and readiness timeline

Container: `ihear-resource-schema-234fbfba-418f-445a-a5ec-0a65c90ac838`.

1. Temporary server starts at `19:35:11.188509` with no TCP listen address.
2. Socket query succeeds at `19:35:11.216012`; the legacy readiness condition is met.
3. Several further socket queries succeed, then the probe receives the exact
   shutdown FATAL. Probe exit 21 intentionally records that observed query failure.
4. Final server starts at `19:35:11.409930`; TCP query succeeds at
   `19:35:11.646273` with address `127.0.0.1`, port 5432, listen address `*`.
5. Five later queries report the same final postmaster start time.
6. Test cleanup begins only at `19:35:14.794Z`, after successful final startup.

The probe increases observation frequency using the same socket connection method;
it does not inject initialization scripts or alter PostgreSQL startup timing.
Two ordinary, instrumented full-suite runs before the fix passed all 32 tests.
Thus the original complete-suite failure was intermittent, not reproduced on
every run. The controlled probe reproduced its exact connection failure without
executing any migration. The original failed CP7 container had already been
auto-removed; its historical logs cannot be recovered, and are not claimed here.

### Lifecycle, cleanup, and parallel interference

- Every observed container was running before intentional cleanup, with zero
  restarts and `OOMKilled=false`. No Docker healthcheck was configured; this is
  recorded as **not configured**, not as a passing healthcheck.
- Each Schema/control container has a UUID name, `--network none`, no published
  host port, and its own anonymous data volume. `docker exec` names that exact
  container. There is no stale host port to reconnect to.
- Read-only review of `tests/resource-topic-api-postgres.test.mjs` confirms a
  separate UUID container, random credentials, dynamically allocated loopback
  port obtained from that container's inspect result, and cleanup of its own
  captured name. Identical inner database names do not share storage.
- As an actual overlap check, the standalone control was cleaned up between
  `19:37:49.600Z` and `19:37:50.913Z`. Concurrent fixed Schema run 1 completed
  Migration 023 at `19:37:52.584Z`, continued SQL until `19:38:08.130Z`, and
  passed all 33 tests. Control cleanup did not terminate the Schema container.
- No other application suites were executed for this remediation. The API
  suite's isolation was inspected, not rerun as part of a resumed release gate.
- Fixed run 2 passed 33 tests but its **post-test** cleanup recorded exit 137:
  `docker stop --time 1` forced termination during the shutdown checkpoint.
  Logs put this after all SQL/test work, with no OOM. This separate cleanup issue
  is preserved, not omitted. Cleanup grace is now 10 seconds. Final fresh run 3
  passed 33 tests and logged a completed shutdown checkpoint and container exit 0.
- Final cleanup uses `docker rm --volumes`. Five earlier diagnostic anonymous
  volumes were removed individually only after matching saved inspect ownership
  and verifying no container referenced them; see `owned-volume-cleanup.json`.

## Changed files

Only the following source/documentation files were changed in this remediation:

- `tests/resource-topics-postgres.test.mjs`: TCP readiness/query fix, one connection
  regression assertion, lifecycle markers, retained diagnostics, explicit cleanup
  with a 10-second grace and anonymous-volume removal. Existing schema assertions
  and migration SQL are unchanged.
- `tests/helpers/postgres-schema-trace.mjs`: scoped container diagnostic collector;
  preserves complete logs, inspect metadata and command timeline without `.env`.
- `scripts/investigate-schema-startup.mjs`: standalone PostgreSQL control and
  read-only legacy socket probe; no application/schema imports or production URLs.
- `docs/postgres-schema-readiness-investigation.md`: this report.
- `docs/resource-topics-checkpoint-7.md`: append-only remediation status reference;
  original failure and STOP report retained.

Generated audit artifacts are under the output directory above. Existing changes
from accepted Checkpoints 1–6 were not reverted, staged, or included as new work.

## Tests executed + results

For Schema runs, `POSTGRES_URL` and `DATABASE_URL` were empty process variables.
Containers use local image `--pull=never`; tests never read database URLs or `.env`.
Runner stdout/stderr are preserved in the named logs with runner exit files.

| Command / run | Result | Evidence |
|---|---|---|
| `npx vitest run tests/resource-topics-postgres.test.mjs`, original socket run 1 | PASS 32, 23.75s | `unfixed-schema-1.log` |
| Same command, original socket run 2 | PASS 32, 25.27s | `unfixed-schema-2.log` |
| `node scripts/investigate-schema-startup.mjs --probe-legacy` | Exact FATAL reproduced, probe exit 21; final server control PASS, runner exit 0 | `legacy-probe.log`, probe `investigation.json` |
| `node scripts/investigate-schema-startup.mjs` | PASS, 5 stable TCP queries, zero schema/migration SQL | `standalone-control.log` |
| Schema command after TCP fix, run 1, concurrent with standalone control | PASS 33, 27.35s; container cleanup exit 0 | `fixed-schema-1.log` |
| Schema command after TCP fix, run 2, fresh isolated container | PASS 33, 27.15s; post-test 1s cleanup exit 137, explained above | `fixed-schema-2.log` |
| Schema command with final 10s cleanup, run 3, fresh isolated container | PASS 33, 24.99s; container cleanup exit 0 | `fixed-schema-3.log` |
| `npx eslint tests/resource-topics-postgres.test.mjs tests/helpers/postgres-schema-trace.mjs scripts/investigate-schema-startup.mjs` | PASS, exit 0 | Infrastructure files only |
| `git diff --check -- tests/resource-topics-postgres.test.mjs tests/helpers/postgres-schema-trace.mjs scripts/investigate-schema-startup.mjs docs/postgres-schema-readiness-investigation.md docs/resource-topics-checkpoint-7.md` | PASS, exit 0 | Scoped check; these files are currently untracked, so not a substitute for ESLint/content review |

New regression coverage verifies the actual SQL endpoint is `127.0.0.1` and PID 1
is `postgres`; a Unix-socket connection would produce NULL for the address.
The original 32 tests continue to validate migration preservation, constraints,
legacy compatibility, statuses, and idempotency in disposable databases only.

## Whether any application/schema/migration logic changed

**No.** Application files, Migration 023, Guide takeover logic, and production
data/schema were not modified. Migration SQL was executed only by the authorized
Schema test setup inside disposable, network-isolated containers.

Unchanged SHA-256 values, matching the earlier accepted artifacts:

- `db/migrations/023_resource_topics.sql`:
  `0AB4DBD9D6C98B486EF008A63A82A0346634BEC1BDBF3CC88417D1DF640DCFE1`
- `scripts/resource-guide-takeover.mjs`:
  `DE8B983CE10523FC26B7B55B2C151C0EA83479D7750D199E885C14C526B10F2B`

## Known issues / unresolved questions

No unresolved blocker in this tested Schema readiness remediation. The original
failed container's logs are unavailable; the same failure mechanism was reproduced
and recorded in a fresh container. Race reproduction is timing-dependent.
The fix and regression were validated against the installed image digest, not
every future image version. Original CP7 baseline differences and unexecuted
release checks remain subject to their existing Review gate.

## No work performed beyond this remediation

No resumed Playwright/E2E, application API integration, build, production migration,
Guides takeover, commit, push, or deployment. No production connection or data
change. **STOP — await Review before resuming any other Checkpoint 7 work.**
