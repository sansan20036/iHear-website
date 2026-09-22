# Checkpoint 7 — Resources fixture audit and remaining gate complete

Date: 2026-09-22. **STOP for final Review. No commit, push or deployment.**
Audit directory: `output/checkpoint-7-resource-audit/`.

## Fixture audit findings

The current public collection contract is `{ topics, items, guidesTakeover }`.
Successful public states are `legacy` and `complete`. Inconsistent stored takeover
state produces HTTP 503 with an error envelope; it is not a successful public
snapshot containing `unavailable`. Actual API projections were inspected in
`app/api/resources/route.ts`, `lib/resource-api.ts`, `lib/resource-types.ts`, and
`lib/resource-guides-takeover.ts`, without modification.

The active `tests/` tree, helpers, smoke runners and production read-only test
definitions were searched. Generated historical output was excluded from active
fixture edits. `fixture-audit.json` and `route-audit-search.txt` preserve the inventory.

| Fixture / response source | Scenario and disposition |
| --- | --- |
| `impact-admin.spec.mjs` — `resourceSnapshot`, four route uses | Legacy Forms/Articles plus nine original Guides. Existing explicit marker retained through shared builder. Topic slugs/three-language empty descriptions and defaults for custom Item category/order now match expected fields. HTTP 503 error branch retained. |
| `resource-anchor-email.smoke.mjs` — three response constructors | Deep links, legacy/collision anchors, Email special characters. All are legacy scenarios; all now use the shared legacy builder. These were three missing-marker fixtures. |
| `resource-topics-public.smoke.mjs` — malicious/private row response | Fourth missing-marker fixture. Now uses a legacy envelope while preserving unsafe URL/private status rows so row filtering, rather than envelope rejection, is exercised. |
| Same public runner — incomplete envelope and HTTP 503 | Intentionally malformed/error scenarios. Kept incomplete/error-only; not repaired into successful responses. |
| `resource-takeover-render.smoke.mjs` — `responseFor(doc)` | Existing explicit state derived from the stored marker retained, then wrapped with shared builder. Pre-takeover stays legacy; takeover, hidden/archived and recovery stay complete; inconsistent storage stays HTTP 503. |
| Same takeover runner — missing marker, contradictory state, duplicate IDs | Deliberate mutations after building a valid snapshot remain intact. Their safe-failure assertions passed. |
| `resource-topics-admin.smoke.mjs` | Actual local API reads. Two error interceptions (admin read 503 and delayed POST 500) correctly remain error-only responses. |
| `resources-admin.smoke.mjs`, `public-pages.smoke.mjs` | Actual local HTTP consumers; no constructed collection response needing repair. |
| API contract/unit/PostgreSQL/takeover tests | Execute actual handlers against isolated/mocked persistence. Stored resource documents are not API envelopes; no response field was injected into the storage model. |
| Model/schema/translation/config/safety fixtures | Not Resources collection response builders. No change. |
| `tests/production/public-site.production.mjs`, `read-only.mjs` | Production read-only consumers/allowlists, no response builders. Inspected only, not executed. |

The shared helper requires an explicit valid success state. The convenience
legacy builder supplies `legacy`; takeover scenarios supply their resolved state.
It does not sanitize supplied records, because doing so would erase adversarial
test data before the application can validate it. Some browser fixtures retain
extra model/status fields deliberately; the helper only owns the response envelope.

## Changed files

- `tests/helpers/resource-public-snapshot.mjs`: new shared response-envelope builder
  and legacy scenario wrapper. Rejects absent/invalid success state at construction.
- `tests/impact-admin.spec.mjs`: reuse builder and complete fixture Topic/default
  Item fields; existing scenario assertions remain unchanged.
- `tests/resource-anchor-email.smoke.mjs`: all three success mocks use the builder.
- `tests/resource-topics-public.smoke.mjs`: fix defensive-row response envelope;
  explicitly document malformed negative fixture; add optional exact `--group`
  selection to run the same Anchor scenario in isolation without rewriting it.
- `tests/resource-takeover-render.smoke.mjs`: use explicit-state shared builder,
  preserving stored-state resolution and all deliberate negative mutations.
- `docs/resource-topics-checkpoint-7-fixture-audit.md`: this report.
- `output/checkpoint-7-resource-audit/`: inventory, command logs/exit status,
  browser reports, copied accepted takeover fixtures, baseline diffs, source
  fingerprints, isolated site-link harness/report and JSON release summary.

No application, API, schema, migration or production source changed. The generated
image optimizer outputs matched their initial hashes. `next-env.d.ts` returned
to its original build reference as part of the normal Next build. Final source
comparison contains only the four modified existing test files; the helper is new.
AST comparison in `assertion-preservation.json` confirms all pre-existing assertion
calls and timeout settings in the four modified test files are unchanged.

## Tests executed + results

| Actual command | Result |
| --- | --- |
| `node tests/resource-topics-public.smoke.mjs --dev --group "Deep links wait for data, preserve stable/suffixed slugs and avoid repeat scrolling"` | PASS: formerly failing Anchor group alone |
| `node tests/resource-topics-public.smoke.mjs --dev --production-reference output/checkpoint-4` | PASS: all 14 public/Anchor/Email workflow groups |
| `node tests/resource-takeover-render.smoke.mjs output/checkpoint-7-resource-audit/takeover-fixture --recovery` | PASS: 20 takeover/negative/three-language/recovery browser groups |
| `npm run test:e2e -- --max-failures=1 --output=output/checkpoint-7-resource-audit/full-results` | PASS: 87 tests, 4.2 minutes |
| `node output/checkpoint-7-resource-audit/site-link-regression.mjs` | PASS: 13 pages × 3 languages; href/target preservation, public external-link hints and rel protection, admin-owned markup unchanged, five actual internal navigations and one intercepted external popup |
| `npm run content:check` | FAIL, exit 1: four known stale artifacts; comparison below confirms no new differences |
| `node output/checkpoint-7-resource-audit/compare-content.mjs` | PASS: isolated generation and accepted source/generated hash comparison |
| `node output/checkpoint-7-resource-audit/compare-hunks.mjs` | PASS: actual current/baseline unified differences saved |
| `node output/checkpoint-7-resource-audit/compare-semantic.mjs` | PASS: catalog field comparison; inventory row grouping subsequently refined |
| `node output/checkpoint-7-resource-audit/compare-inventory-fields.mjs` | PASS: no new inventory field differences; final `noNewDifferences: true` |
| `npm run lint` | PASS, exit 0 |
| `npm run typecheck` | PASS, exit 0 |
| `git diff --check` | PASS, exit 0; CRLF notices only |
| `npm run build` | PASS, exit 0: assets generated, Next production compilation, TypeScript, page generation and optimization complete |

Public smoke includes actual local API filtering, three languages/fallback,
320/390/1440px and keyboard operation, stable/suffixed and old anchors, unavailable
anchors/DOM collisions, refresh focus/scroll behavior, Email subject round-trip
encoding (Chinese, spaces, `& ? # %`, Emoji), external/text behavior, admin copy URL
clipboard success/denial/manual fallback, and saved production-reference content.
Full E2E also covers 13 pages across six viewport configurations, Team/media/layout
regressions, narrow mobile navigation and keyboard behavior.

The link harness isolates the actual shared `site.js` against current generated
HTML, excluding other scripts and intercepting all network. It is a focused
script/link regression, not a production traffic test or a substitute for actual
Admin/Public API workflows. The latter have separate successful smoke evidence.

Earlier accepted runs are not mislabeled as rerun here: Schema 33, real PostgreSQL
API 45, other API 324, operations 25, takeover/restore unit 11 passed in the resumed
CP7 run; Admin Resources 17 groups passed in the subsequent layout-fixture run.
See `resource-topics-checkpoint-7-resumed.md` and
`resource-topics-checkpoint-7-layout-fixture.md`. Application sources have not
changed since those runs. This continuation executes the requested remaining gate.

## Regression / baseline comparison

Baseline commit: `5706e268015eebd421ce5d3e5af2ac261d944e6a`, accepted CP4 evidence.
Generator `--write` ran only in the isolated audit copy; source content was not
silently refreshed.

- `index.html`, `stories.html`: source and generated hashes exactly match saved
  CP4 fingerprints; existing gallery/layout attribute-order difference only.
- `data/content-slots.json`: 164 current field differences, zero novel before/after
  values; 36 baseline differences previously resolved by accepted work.
- `docs/content-slot-inventory.md`: 164 current per-field/per-file differences,
  zero novel differences; 35 prior differences resolved.
- All four generated outputs match the accepted CP4 output hashes.

Actual diff artifacts, not merely matching filenames, support the conclusion.
`content-semantic-comparison.json` records `noNewDifferences: true`.
The raw command remains FAIL and is reported as the previously accepted baseline
exception. No new test failure or unexplained content difference occurred.

## Known issues / unresolved questions

- `content:check` is still not green; its exact pre-existing discrepancy is fully
  accounted for. No content reconciliation was authorized or performed.
- Browser checks use Chromium emulation; physical phones and native mail clients
  were not tested. Email tests validate href/encoding and intercept activation;
  no email is sent. Live Google translation/OAuth are not part of this fixture audit.
- Public/Admin smoke ran against local Next dev; production output was built
  successfully but no production deployment/traffic smoke was performed.
- Saved CP4/CP6 reference snapshots were reused without contacting production.
  This verifies preserved reference content, not whether administrators have
  changed the live site since those snapshots.
- No unresolved fixture-contract mismatch was found beyond deliberate negative
  cases. Future response builders should reuse the shared helper and choose state
  explicitly; error envelopes remain distinct.

## Release readiness

**Requested remaining validation complete; ready for final Review with the known
content baseline exception.** All newly executed functional/browser/static/build
checks passed; `content:check` retains its explained baseline FAIL. This is not
an unconditional all-green claim or deployment approval.

STOP here. Do not commit, push, migrate production or deploy until separately
authorized following Review.

## No production changes performed

No production connection, data/schema modification, migration, commit, push or
deployment. Test data used fresh local directories or copies of the accepted
isolated rehearsal artifacts. Build forced local file storage with cleared database
URLs. `.env.local` was not edited; no credentials were copied into reports.
