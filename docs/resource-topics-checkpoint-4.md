# Resources public page — Checkpoint 4

## Changed files

These are the Checkpoint 4 changes only. Earlier accepted checkpoints remain in
the working tree and are not counted as new work here.

* `resources.html`: dynamic catalog shell; existing nine guides become list rows,
  retaining CMS keys, translations, layout order keys and existing request link.
* `assets/resources.js`: published topic/item rendering, sorting, localization,
  safe external links, type labels, errors/retry, refresh and management entries.
* `assets/site.css`: scoped resource list, topic, type-label and focus styling.
* `app/admin/resources/page.tsx`: read the topicId query for the corresponding
  public topic's management entry. No other new management workflow.
* `scripts/prepare-public.mjs`: inject resources.js for the new catalog marker and
  version its asset URL.
* `scripts/generate-content-slots.mjs`: recognize the legacy guides' new list
  structure without changing their content/layout identifiers.
* `data/content-slots.json`: Resources occurrence locations only; content unchanged.
* `docs/content-slot-inventory.md`: corresponding occurrence locations.
* `tests/resource-topics-public.smoke.mjs`: isolated API/browser visibility,
  rendering, language, keyboard, refresh and content-preservation coverage.
* `tests/impact-admin.spec.mjs`: three existing Resources cases use topic/item
  snapshots and the updated public selectors.
* `tests/resources-admin.smoke.mjs`: public selectors follow the new lists;
  existing administration regression behavior remains intact.
* `package.json`: add test:resource-topics-public.
* `docs/resource-topics-checkpoint-4.md`: this review record and deferred checklist.
* `docs/resource-topics-checkpoint-4-baseline.json`: review follow-up evidence;
  baseline commit and LF-normalized source/generated fingerprints. No application
  code changed during this review follow-up.

## What was implemented

The dynamic catalog uses only the public /api/resources projection, even for an
administrator. Published parents and children are required; empty topics are
omitted. Defensive rendering also rejects explicitly nonpublished records,
unknown types, orphaned children and unsafe external URLs. Topic/item order is
numeric sortOrder followed by the existing ID tie-break. All content is rendered
as text rather than HTML. Titles and descriptions independently fall back to
English when the selected Chinese field is absent.

External links open a new tab with an explicit hint and noopener/noreferrer.
Email-request and text items have distinct labels and no fake actionable link.
Administrators see a per-topic management link that opens the matching filtered
item list. Visitors see no management controls. Unchanged background refreshes
preserve DOM/focus; changed results preserve focus by record ID where possible.
A failed read clears the dynamic snapshot and offers Retry, rather than retaining
possibly unpublished stale content. No administrator projection is used as a
public fallback.

The nine legacy guides remain a separate compatibility section, reformatted as
list rows. Their existing names, introductory copy, language values, editable
keys, ordering and email request link are retained. No missing descriptions were
invented. This section is not a published projection of the new draft `guides`
placeholder topic; see the transition limitation below.

## Tests executed + results

* PASS — `node tests/resource-topics-public.smoke.mjs --dev --production-reference output/checkpoint-4`
  — 10 workflow groups: real public filtering/HTML privacy, numeric ordering,
  three types and safe text rendering, three-language fallback, 320/390/1440px
  layout and keyboard, unchanged-refresh focus and external activation, scoped
  admin entry, live parent hiding, failed reads/retry, malformed responses and
  production-reference preservation. Test data and authenticated writes were
  confined to an isolated local file store.
* PASS — `npm run test:e2e -- -g "Resources"` — 3 tests.
* PASS — `npm run test:resources-admin -- --dev` — existing administration smoke:
  translation preview/save, expired preview, input errors, cancel/confirm hide,
  draft/publish, manual Chinese, sorting, live refresh, archive/restore, conflict,
  visitor access and 320/390/1440px.
* PASS — `npm run lint`.
* PASS — `npm run typecheck`.
* PASS — `git diff --check` (line-ending notices only).
* FAIL — `npm run content:check`: stale data/content-slots.json,
  docs/content-slot-inventory.md, index.html and stories.html. An isolated baseline
  using the pre-Checkpoint-4 Resources HTML/generator produced the same mismatch
  list. Existing unrelated generated-artifact drift was not rewritten here.
  Only the Resources occurrence metadata was updated. Resolve before final build.
* Visual review: inspected generated 320px Traditional Chinese and 1440px English
  screenshots; readable rows/focus outline and no horizontal overflow. Automated
  checks additionally cover all three locales at all three widths.

GET-only production reference reads returned HTTP 200 for /resources,
/api/resources, /api/content?page=%2Fresources and /api/layout?page=%2Fresources.
The captured public reference contains 5 Forms, 0 Articles and 9 legacy Guides.
The local test compares names, descriptions and external URLs across languages,
and checks guide text against the captured production content. Reference files
and screenshots stay in ignored output directories. This is a point-in-time
comparison, not a promise against subsequent administrator edits.

## Data/schema implications

No table, column, index, constraint, foreign key, API or migration change in this
checkpoint. No production data was modified. No production migration, deployment,
commit or push was performed. Browser writes targeted only isolated fixtures.
Earlier checkpoints' schema/API work remains unmodified by this checkpoint.

## Known issues / unresolved questions

1. Legacy guide transition: the nine current guides are still backed by legacy
   HTML/CMS content, while the new `guides` topic is an empty draft placeholder.
   Preserving the existing public content without performing a migration means
   that legacy section is not governed by new Topic status/order controls yet.
   This assumption was communicated during implementation. Migration rehearsal
   must verify an atomic takeover and remove the compatibility section, preventing
   duplicate guides or hidden content reappearing through a legacy fallback.
2. Existing content:check drift above remains unresolved; the check is not marked
   passing. Full build and wider regression remain scheduled for Checkpoint 7.
3. Real phones and live Google translation were not exercised; Chromium viewport
   checks and existing translation-protection regression were used here.

### Checkpoint 6 migration acceptance criteria confirmed during review

* Replace the legacy Guides source with the new Topic/Item model; remove legacy
  rendering on takeover so each guide appears exactly once.
* Reconcile all nine guides individually using stable identities, not counts
  alone: none missing and none duplicated.
* Preserve all three languages, configured ordering and applicable hidden
  settings. Record how legacy visibility maps to Topic/Item publication status;
  do not silently publish a previously hidden guide.
* All nine migrated guide items must have explicit type `email_request`.
* Demonstrate these checks in migration rehearsal before any production takeover.

### Checkpoint 7 regression checklist requested during review

* Verify shared assets/site.js link behavior on public home, Team, Resources and
  other main pages: internal navigation, external target/rel/hints and admin
  links. The Checkpoint 3 exclusion for React-owned .admin-app links must not
  change public behavior. No further site.js edit was made in Checkpoint 4.
* Use baseline-aware validation for content:check, not a blanket exception for a
  known failure. Re-run and compare the actual source-to-generated diff hunks
  against the saved baseline, separating intentional checkpoint changes from
  pre-existing drift. An unchanged list of failing filenames alone is not proof.
  Any additional unexplained discrepancy is a new regression and must be resolved.
  Keep reporting FAIL until the artifacts are reconciled and the command passes.
* Review evidence: resource-topics-checkpoint-4-baseline.json records the baseline
  commit and normalized fingerprints for index.html/stories.html. Their source
  files are unchanged and the before/after generator outputs are identical, so
  their discrepancies are identical. Catalog comparisons also confirm both source
  and generated metadata outside Resources are unchanged. The isolated generated
  copies remain under output/checkpoint-4/catalog-baseline and catalog-current.
* Recheck final build after resolving pre-existing drift.
* Verify migrated Guides are governed by Topic publication/order and appear once.
* Reserve physical-device and live translation checks for preproduction manual
  smoke testing, as agreed.

## No work performed beyond this checkpoint

Stopped at Checkpoint 4. No new Anchor UX, mailto generation/encoding, production
migration, deployment or subsequent checkpoint implementation. Existing built-in
destinations and the original guide email link were retained, not extended.
Checkpoint 5 requires explicit acceptance before work starts.
