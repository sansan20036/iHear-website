# Checkpoint 7 — fixture correction passed; STOP at another E2E fixture failure

Date: 2026-09-22. Evidence directory: `output/checkpoint-7-fixture-fix/`.

## Root cause confirmation

The previously failing Resources test mocked only `topics` and `items`, omitting
the mandatory `guidesTakeover` field. Its intended scenario contains external
Forms/Articles plus the nine original legacy Guides, so `legacy` is the correct
state. `resourceSnapshot()` now explicitly returns `guidesTakeover: "legacy"`.
The isolated formerly failing test passes without changing any assertion, timeout,
application rendering rule, or API contract.

The subsequent full suite reached a **new failure** and stopped as requested:

`tests/impact-admin.spec.mjs:886` —
`layout settings use the page control without a hover toolbar`.

At line 889 it tries to hover `[data-layout-group="resources.guides"]`. The
element exists but remains hidden, and Playwright times out after 30 seconds.
Read-only inspection of its preserved trace found two requests to the local
`http://127.0.0.1:3210/api/resources`, both returning HTTP 404 with empty bodies.
Unlike the three explicit Resources tests, this layout test does not register
a Resources API response; the shared `mockApplication()` also lacks that route.
The static fixture server cannot provide the API. The accepted renderer therefore
keeps legacy Guides hidden when the authoritative Resources snapshot is unavailable.

This explains the new failure as missing test setup. It is not evidence of
production data loss or a reason to weaken the application's fail-closed behavior.
No fix or rerun of this newly failing test was performed after STOP.

## Changed files

- `tests/impact-admin.spec.mjs`: one `guidesTakeover: "legacy"` property in the
  existing Resources mock helper, plus a scenario comment. All assertions retained.
- `docs/resource-topics-checkpoint-7-fixture-fix.md`: this report.
- `output/checkpoint-7-fixture-fix/`: before-source copy, exact local patch,
  source fingerprints, command logs/exit files, isolated/full HTML reports,
  failure screenshot/trace, extracted API response evidence, and JSON summary.

`source-fingerprint-comparison.json` shows that among all pre-existing source
files only `tests/impact-admin.spec.mjs` changed during this continuation.
`fixture-change.diff` records the exact bounded modification independently of
the larger uncommitted changes from prior checkpoints.

## Tests executed + results

Both commands set `IHEAR_E2E_SLOWMO=0`, clear inherited database URL variables,
use fresh browser contexts and the local static test server, and preserve separate
report directories. No retries were enabled or performed.

| Command | Result |
| --- | --- |
| `npm run test:e2e -- --max-failures=1 --output=output/checkpoint-7-fixture-fix/isolated-results -g "Resources show verified form links"` | PASS: 1 test, 4.9s total; checks include 3 forms, 9 legacy Guides, three languages, 320/390/1440px, external-link attributes and admin entry |
| `npm run test:e2e -- --max-failures=1 --output=output/checkpoint-7-fixture-fix/full-results` | FAIL: 18 passed, 1 failed, 68 not run; 1.3 minutes total |

All three existing Resources tests passed in the full run, including localized
links, published Articles, keyboard focus, empty sections, retry and refresh.
The full runner also reports one error outside a test; the original output is
preserved without claiming a separate proven cause or a passing overall result.

New-failure artifacts:

- `full-e2e.log`, `full-e2e.exit.txt`.
- `layout-failure-response.json`: actual local 404 responses extracted from trace.
- `full-results/impact-admin-layout-settin-5c3db-rol-without-a-hover-toolbar/trace.zip`.
- Same directory: `test-failed-1.png`, `error-context.md`.
- `full-report/index.html`.

## Regression / baseline comparison

The requested mock repair resolves the original failure and does not alter
application/API/schema/migration behavior. The new layout test failure blocks
the gate; it was not dismissed as flaky or retried with a larger timeout.

The content baseline comparison was **not rerun in this continuation**, because
the ordered full E2E step failed first. The preceding resumed CP7 report recorded
`content:check` FAIL with zero new field-level differences; that is historical
evidence, not a new passing check. Source fingerprint verification confirms no
content or application source changed in this continuation.

## Known issues / unresolved questions

- The layout test requires an explicit valid Resources snapshot matching its
  legacy-Guides scenario; this newly discovered fixture gap remains unmodified.
- After STOP, no Admin Resources workflow smoke, Public Resources/Anchor/Email
  smoke, complete site-link regression, remaining responsive/keyboard coverage,
  content baseline rerun, lint, typecheck, `git diff --check`, or production build
  was performed. Passing subsets above do not establish full release coverage.
- Remaining tests may reveal additional stale mocks; they have not been executed
  and are not reported as passing.

## Release readiness

**NOT READY — CHECKPOINT 7 STOPPED.** The original fixture repair is verified,
but the newly failing layout fixture requires Review before further changes or
continuation. No application regression has been proven by this local 404 fixture.

## No production changes performed

No application/API/schema/migration/production code changes, production data
changes, commit, push, or deployment. After the new failure, only existing
trace/source inspection, evidence preservation and this report were performed.
