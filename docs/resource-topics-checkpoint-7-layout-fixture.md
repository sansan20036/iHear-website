# Checkpoint 7 — layout fixture repaired; STOP at Anchor smoke fixture

Date: 2026-09-22. Audit directory: `output/checkpoint-7-layout-fixture/`.

## Root cause confirmation

The layout-settings E2E test did not register `/api/resources`. The local static
server therefore returned 404 and the accepted fail-closed renderer kept legacy
Guides hidden. The test's hover target could not become visible.

Only that test's setup was changed: import `RESOURCE_SEEDS` and fulfill the API
using the existing `resourceSnapshot()` helper. The helper supplies Topics,
external-link Items and `guidesTakeover: "legacy"`, matching a scenario that
intentionally retains the nine original Guides. The hover and all existing
assertions/timeouts remain unchanged. The isolated test and full E2E suite pass.

The next failure occurred later, during Public Resources smoke testing:

- `tests/resource-anchor-email.smoke.mjs:11`, scenario `Deep links wait for data,
  preserve stable/suffixed slugs and avoid repeat scrolling`.
- `journal` Topic heading was not found; `toBeFocused()` timed out after 20 seconds.
- The failing page's matcher ariaSnapshot says `Resources could not be loaded.`
- Read-only source inspection finds another independent API mock at lines 5–7:
  it supplies Topics/Items but omits required `guidesTakeover`.
- `assets/resources.js:64` rejects a missing marker. This explains the absent
  Topic before anchor positioning can occur. It does not prove an application
  anchor bug, production API failure, or missing production data.

No correction or retry of the newly failing Anchor fixture was performed. Work
stopped at this failure as instructed.

## Changed files

- `tests/impact-admin.spec.mjs`: two setup lines inside the one affected layout
  test. No changes to the shared helper, other test scenarios, or assertions.
- `docs/resource-topics-checkpoint-7-layout-fixture.md`: this report.
- `output/checkpoint-7-layout-fixture/`: exact patch and initial source copy,
  fingerprints, command logs/exit codes, isolated/full Playwright reports,
  failure-source snapshot, browser screenshot evidence, and JSON summary.

Next dev regenerated `next-env.d.ts` while smoke tests ran. It was restored only
after finding bytes whose SHA-256 exactly matched this continuation's initial
fingerprint. `generated-file-cleanup.json` records the generated and restored
hashes. This was cleanup of a generated test artifact, not a functional edit.
Final `source-fingerprint-comparison.json` confirms that among all pre-existing
files only `tests/impact-admin.spec.mjs` remains changed in this continuation.

## Tests executed + results

| Actual command | Result |
| --- | --- |
| `npm run test:e2e -- --max-failures=1 --output=output/checkpoint-7-layout-fixture/isolated-results -g "layout settings use the page control without a hover toolbar"` | PASS: 1 test, 3.8s total |
| `npm run test:e2e -- --max-failures=1 --output=output/checkpoint-7-layout-fixture/full-results` | PASS: all 87 tests, 4.1 minutes |
| `node tests/resource-topics-admin.smoke.mjs --dev` | PASS: all 17 admin workflow groups |
| `node tests/resource-topics-public.smoke.mjs --dev --production-reference output/checkpoint-4` | FAIL: first 6 groups passed, then first Anchor group failed; runner exit 1 |

E2E uses new browser contexts and the local static server, with slow motion off
and separate report/result directories. The Admin/Public smoke runners each create
a fresh local data directory and local Next server. Database URL variables were
cleared and file storage forced; no production credential was used to access data.
The `--production-reference` argument reads saved CP4 files on disk; it does not
contact production. Tests were run sequentially, with no retry after the failure.

The complete E2E run covers all 13 public source pages at 1440, 1024, 768, 390,
320 and short-landscape widths, duplicate IDs/overflow/headings, keyboard skip
links, mobile navigation, Resources links, image/gallery behavior and Team editing.

The 17 Admin groups cover authorization, Topic and three Item types, ordering,
publication/hiding, archive/restore status, topic-reference restrictions, item
movement, 409 input preservation, save deduplication, errors/retry, manual Chinese,
three-language controls, keyboard cancel/focus, 320/390/1440 layouts, actual narrow
phone create/save operations and cross-tab updates.

The six passing Public groups cover real API publication filtering, no private
payload leakage, numeric/stable ordering, legacy Guides, all three Item types,
safe strings, one Email href, three languages and fallback, 320/390/1440 layouts,
keyboard focus, external link activation, and per-topic admin entry behavior.
They do not substitute for the unexecuted complete Anchor/Email test groups.

## Regression / baseline comparison

The repaired layout scenario and full E2E suite pass without weakening assertions
or changing application behavior. The separate Anchor mock/API mismatch remains
a release-gate failure even though its immediate cause is explainable.

Content comparison scripts were copied into the new audit directory in preparation,
but **not executed** after the smoke failure. The preceding CP7 comparison had
reported `content:check` FAIL with zero novel field-level differences. That is
historical evidence only; this continuation does not claim a fresh baseline pass.
Source hashes confirm that content, API, schema and migration sources are unchanged.

## Known issues / unresolved questions

1. The Anchor smoke mock lacks `guidesTakeover`. It remains unmodified pending
   Review. The test does not yet reach its stable/sluggified anchor assertions.
2. The smoke runner has no trace capture. Its error handler screenshots the parent
   Resources page, not the newly opened Anchor page. The actual failing-page
   evidence is the matcher ariaSnapshot in `public-workflows.log`; the saved
   `public-workflows-parent-page.png` is explicitly not the failing Anchor page.
3. Not completed: remaining Public/Anchor/Email groups, current migrated-Guides
   browser rerun, dedicated full-site `site.js` link regression, fresh content
   baseline comparison, lint, typecheck, `git diff --check`, production build.
4. Existing E2E responsive/keyboard coverage and Admin/Public coverage described
   above passed; remaining workflow coverage is not silently counted as passing.

Evidence: `isolated-e2e.log`, `full-e2e.log`, `admin-workflows.log`,
`public-workflows.log`, their `.exit.txt` files, `anchor-failure-evidence.json`,
`resource-anchor-email.failure-source.mjs`, `fixture-change.diff`, and
`release-gate-summary.json`. Prior failures remain in their original audit folders.

## Release readiness

**NOT READY — CHECKPOINT 7 STOPPED.** The layout fixture correction is verified,
full E2E passes, and Admin workflows pass. The newly failing Anchor mock must be
reviewed before additional corrections or continuation. No retries or later
release checks were performed after this failure.

## No production changes performed

No application/API/schema/migration behavior or production code changed. No
production data/schema access or writes, commit, push, deployment, or production
migration. After STOP, work was limited to read-only diagnosis, artifact retention,
restoring the generated Next type file to its exact starting bytes, and reporting.
