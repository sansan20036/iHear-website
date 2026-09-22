# Resources Admin UI — Checkpoint 3

Scope: `/admin/resources` and the frontend interactions required to manage
Checkpoint 2 topics/items. No new API, schema, migration, public Resources
renderer, anchor navigation or email behavior is implemented here.

## Changed files

* `app/admin/resources/page.tsx`: topic/item management, state filters, editor,
  preview/save workflow, moving items, archive/restore, conflict recovery,
  request guards and cross-tab refresh.
* `app/admin/resources/resource-copy.ts`: extracted existing three-language editor
  and translation workflow copy.
* `app/admin/resources/topic-copy.ts`: three-language labels and actionable errors
  for topic/item management.
* `app/admin/admin.css`: responsive resource filters, selects and header wrapping.
* `assets/site.js`: skip React-owned administrator links when adding external-link
  hints. This prevents a confirmed pre-hydration DOM mutation on the admin page;
  public link behavior is unchanged.
* `tests/resource-topics-admin.smoke.mjs`: isolated browser workflow verification.
* `tests/resources-admin.smoke.mjs`: retain the existing regression flow, select
  the legacy Articles topic instead of the removed category selector, update
  the conflict copy assertion, and support local development mode.
* `package.json`: add `test:resource-topics-admin`.
* `docs/resource-topics-checkpoint-3.md`: this implementation/review record.

## What was implemented

The page has Topic and Resource views. Each has All active, Published, Draft /
hidden and Trash filters. Resource view also filters by topic. Both active and
archived snapshots are requested using authenticated management flags, so draft
and archived records remain manageable. Archived records offer Restore; editing
is available after restore. A Topic's View resources button scopes the item list.

Both editors accept English, Traditional Chinese and Simplified Chinese names and
optional descriptions, plus integer order (0–1,000,000). New records default to
draft. Saves retain the existing two-stage translation preview and confirmation
workflow, including explicit confirmation when taking a published record offline.
Topic preview uses scope `topic`; item preview retains the empty scope. Manual
Chinese is protected unless the administrator explicitly selects the override.
Preview failures/expiry preserve input and can be retried. No external translation
credentials are needed for the tests: previews run with automatic translation off.

Resource editors explicitly choose external_link, email_request or text. Only
external links show/require the HTTPS URL field. Switching to non-link types clears
the URL; descriptions hold text content. Active topics, including drafts, may be
selected as destinations. A warning explains that an item under a draft topic
remains invisible regardless of the item's own publication status. Legacy forms /
articles category values stay coherent when selecting those two built-in topics.

Archive is reversible and uses the existing APIs. Restoration honors the previous
published/draft state. Topic cards show reference counts including archived items;
the server remains authoritative when rejecting an occupied topic's archival.
The error tells administrators to move items, restore archived items before moving,
or use Hide for temporarily taking a whole topic offline.

Version conflicts keep editor input and prevent resubmission. Load latest record
requires confirmation before discarding any input, then uses the authenticated
single-record API and refreshes the version. Cancellation leaves input intact.
Other errors are translated into understandable messages instead of exposing raw
backend errors. Save/preview/action requests have an immediate ref-based guard and
disabled controls. Lists refresh after successful mutations and receive existing
BroadcastChannel notifications without replacing an open editor's input.

## Tests executed + results

Final results are recorded after running the commands below:

| Command | Result |
| --- | --- |
| `node scripts/prepare-public.mjs` | PASS — prepared 13 local HTML pages and current assets |
| `npm run test:resource-topics-admin -- --dev` | PASS — 17 admin workflow groups |
| `npm run test:resources-admin -- --dev` | PASS — existing resource workflow regression |
| `npm exec -- vitest run tests/resource-topic-api.test.mjs tests/resources-api.test.mjs` | PASS — 52 tests, 2 files |
| `npm run lint` | PASS |
| `npm run typecheck` | PASS |
| `git diff --check` | PASS |

The browser tests use real local Next.js, route handlers, file storage and
translation receipts, with a local test-only Auth.js session. Requests are paced
to respect the real mutation/translation rate limits. Only failure-injection
cases intercept responses to exercise UI recovery. The test data directories
are separate temporary directories under ignored `output/playwright/`.

Coverage includes topic/item creation and editing, all three item types,
publication/hiding, ordering, item moves, occupied-topic restrictions including
archived children, both archive origins, version conflicts, confirming/cancelling
latest-record replacement, failed read/save retry, duplicate submission protection,
manual Chinese preservation, URL validation, type changes, keyboard dismissal,
three UI languages and 320/390/1440px layouts. The existing regression also covers
expired receipts and unchanged legacy public link behavior. Screenshots are saved
under `output/playwright/resource-topics-*.png` and visually inspected.
The extended run also performs real topic creation/save at 320px and item
creation/save at 390px, and checks that cross-tab refresh does not overwrite
another editor's unsaved input. Viewport screenshots wait for the existing
sidebar transition to settle rather than capturing an intermediate animation.

Run `node scripts/prepare-public.mjs` before the two `--dev` smoke commands. Run
them sequentially because Next.js development instances share a build-cache lock.

Initial runs found and corrected missing explicit select labels and the shared
script's admin DOM mutation. Test assertions were scoped away from Next.js's own
route announcer, and dev-mode waits account for cold route compilation and rate
limit pacing. The initial test runner's Webpack option generated an incompatible
legacy validator for an unchanged content endpoint; the runner now uses the
project's default Turbopack dev mode. Only that test-generated validator directory
was removed, and typecheck passed without changing the endpoint or weakening checks.

## Data/schema implications

None. The accepted Checkpoint 1 model and Checkpoint 2 API remain unchanged. No
formal migration, production database connection, production data write, production
backup, commit, push or deployment was performed. The local tests initialize only
their isolated fixtures; existing project data, production photos and translations
are not replaced. Existing guide content is not migrated in this checkpoint.

## Known issues / unresolved questions

No known blocking issue in the implemented admin workflows. Validation uses
Chromium viewport simulation, not physical iOS/Android devices. Live Google
translation-provider availability is not tested. Production build and full site
integration remain part of the later checkpoint. New topic/type public rendering
is intentionally unavailable until Checkpoint 4; this checkpoint is not a standalone
production release.

## No work performed beyond this checkpoint

No public Resources rendering, Anchor UI, Email UI, formal/production migration
or later checkpoint work. STOP pending explicit review and acceptance.
