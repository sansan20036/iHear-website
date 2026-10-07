# CP2 — Media Admin Integration

Status: **Passed**, 2026-10-07. Stopped at the media admin checkpoint.

## Starting point and scope

The observed HEAD was `fd6a93dd433da347ca4e5d412c25d6f5280fc57f`. The worktree already contained 19 modified/untracked entries from CP0/CP1; these were preserved. No commit, reset, migration, production database write or deployment was performed. The initial status and hashes are recorded in `output/cp2-media-admin/baseline.json`.

The repository's media documentation and accepted [CP1 report](media-contract-checkpoint-1.md) were reviewed, along with the editor, admin context/API helper, shared media types, both gallery routes, store, resolver, image handling, migration runner and existing smoke tests. No separate media checkpoint plan with a different formal name was found, so this checkpoint uses **CP2 — Media Admin Integration**.

Two repository/spec differences were reported before editing: CP1 accepted title strings up to 300 characters and allowed Banner video writes. CP2 adds the requested 120-character editing limit and photo-only Banner guard at the existing mutation boundary. It does not change the title storage shape, store, resolver, GET routes or migrations. Unchanged historical title values, including longer values, are retained rather than truncated. Already committed video operations remain replayable.

## Files changed in this checkpoint

| File | Change and reason |
| --- | --- |
| `app/admin/media/page.tsx` | Add Banner selection, photo-only guidance, three title inputs, preview locale, central crop, empty/error states and conflict recovery. Retain existing save/retry/notification mechanisms. |
| `app/admin/admin.css` | Local Banner preview/title layout and responsive fields; existing gallery presentation remains available. |
| `lib/media-gallery-types.ts` | Share `GALLERY_TITLE_LIMIT = 120` between UI and API. |
| `app/api/media-galleries/[id]/route.ts` | Validate changed title values against 120, preserve unchanged legacy values, reject new Banner video puts after operation replay reconciliation. |
| `tests/media-banner-contract.test.mjs` | Extend API compatibility boundaries, legacy preservation, photo metadata, hidden filtering and all five legacy video contracts. |
| `tests/media-banner-admin.smoke.mjs` | Add 10 real browser acceptance scenarios and persistent visual/data evidence. |
| `package.json` | Add `test:media-banner-admin`; include it after the existing smoke in `test:media-admin`, and therefore in `check`. |
| `docs/media-galleries.md` | Update current usage/limits and distinguish the admin preview from the future homepage container. |
| `docs/media-admin-checkpoint-2.md` | Record scope, verification, evidence and handoff. |

This list is relative to the CP2 starting worktree, not a claim that every `git diff HEAD` change belongs to CP2. The CP1 report remains unchanged.

## Completed editor behavior

`/admin/media?gallery=home-banner` opens the correct collection. Existing photo upload, replacement, editing, ordering, hidden, removal and versioned saves are used. Hidden photos remain editable; public filtered reads exclude them until restored. Banner offers no YouTube add action, and direct video puts are rejected. Original gallery video controls still work. A historical Banner video has a clear unsupported notice and can be moved or removed, without offering a video save.

Collection switching is disabled while a draft or save is pending. Switching after completion/discard clears collection-specific drafts, errors and confirmation state. Initial asynchronous loading uses the selected collection. Removing all Banner photos and refreshing/switching leaves an empty collection; no seed is created by the editor.

Titles use `en`, `zhHant`, `zhHans`. **The whole title is nullable; individual locale values are strings**, including empty strings. The title limit uses trimmed JavaScript UTF-16 string length, consistently in the counter, validation and API; 60 emoji count as 120 units. Captions retain their separate 300-character limit.

| User action | Payload/preservation behavior |
| --- | --- |
| Leave title untouched | Omit `title`; API preserves the saved value. |
| Explicitly clear all three inputs / use clear button | Send `title: null`. |
| Change one language | Send the three-language object with other values preserved. |
| Leave a translated title blank | Keep `''`; preview displays English only, with the correct English `lang` attribute. No fallback text is written into the blank field. |
| Change order or hidden | Move uses only the item ID/direction; hidden puts omit title and image metadata. |
| Change only title/caption | Do not resend unchanged alt/image metadata or create a replacement asset. |
| Refresh after a version conflict | Retain edited values, adopt latest untouched title/caption locales, hidden and unchanged image/provenance details. Then require another save. |

The existing version and operationId mechanism remains authoritative. An uncertain result keeps its frozen payload; retry queries the single-item operation-status route before resending. A 409 does not save or show success. A remotely removed item cannot be resurrected by a preserved draft; the user can retain/copy its text or discard it. BroadcastChannel, embedded editor postMessage and revision polling are unchanged; the original embedded-editor regression verifies immediate refresh and save/close guards.

## Preview decision

No finalized Banner container ratio was found in the repository. The original gallery's 16:9 `contain` frame and `home.hero` source dimensions do not establish that future layout. CP2 uses **provisional local 16:9**, `object-fit: cover`, `object-position: 50% 50%`, with a stable aspect-ratio frame. This is an admin CSS setting only, not a new data-contract field. Long titles wrap below the image. An image-load failure keeps the frame and shows a readable replacement hint.

An actual 600 × 1000 portrait with red/green/blue bands was uploaded. The stored variant retains the portrait composition, while three pixel samples of the wide central preview are green. Its stored-image SHA-256 is identical before and after preview. No crop coordinates, original image mutation, processing service or media editor system was introduced.

## Executed verification

Tests used the built Next.js application on loopback ports 3212 and 3213, test-only authentication and independent file stores under `output/playwright/`. `IHEAR_FORCE_FILE_STORE=1` and `IHEAR_TEST_DATA_DIR` explicitly select isolation; database/storage deployment environment variables are cleared in the test child process. The final Banner browser was Chromium; its exact version and isolated directory are in `results.json`. Servers were stopped after testing. No production data or credentials were used by these smoke tests.

Logs below are under `output/cp2-media-admin/`.

| Actual command | Passed / failed / skipped | Exit | Evidence |
| --- | --- | --- | --- |
| `npm run test:media-contract` | 98 / 0 / 0 (4 files; also included in full API run) | 0 | Full API log covers these same cases. |
| `npm run test:api` | 365 / 0 / 0 (21 files) | 0 | `api.log` |
| `npm run test:operations` | 47 / 0 / 0 (3 files) | 0 | `operations.log` |
| `npm run content:check` | 293 logical slots across 13 pages verified | 0 | `content.log` |
| `npm run lint` | Passed | 0 | `lint.log` |
| `npm run typecheck` | Passed | 0 | `typecheck.log` |
| `npm run build` | Production compilation, TypeScript and page generation passed | 0 | `build.log` |
| `node tests/media-admin.smoke.mjs` | Existing smoke passed; no skipped flow | 0 | `legacy-media-admin.log` |
| `npm run test:media-banner-admin` | 10 / 0 / 0 | 0 | `banner-admin.log`, browser `results.json` |
| `git diff --check` | Passed | 0 | `diff-check.log` |
| `node output/cp2-media-admin/verify-baseline.mjs` | 24 migrations and 14 protected files unchanged | 0 | `preservation.log`, `final-preservation.json` |

The initial browser run also passed; a final build and both admin smokes were repeated after the final conflict-refresh provenance adjustment. The 503, lost response and image-load errors are deliberate test injections, not unexplained failures. The 409 is produced by actual concurrent API writes. Final screenshots wait for the existing sidebar transition and include viewport captures to avoid misleading full-page screenshot artifacts.

### Ten Banner browser scenarios

1. Real photo uploads, three-language title save and reload from storage.
2. Blank translations, English display fallback and one-language edit preserving others.
3. Explicit clearing to null; untouched title omitted from a caption-only payload.
4. Reorder and hidden preserve metadata; edit while hidden; public filtering reverses when shown.
5. 503 retains the draft and shows failure; retry checks operationId and commits once.
6. Lost committed response reconciles without another version increment.
7. Actual same-item conflict retains local English and remote title/caption/hidden/image values after refresh.
8. Banner video rejection, five legacy collection controls and representative video save/reload; unfiltered GET and operation-status semantics.
9. Title limits, 1280/320/390 layouts, centered pixels, original-image preservation and image-load failure.
10. Remotely deleted draft cannot recreate an item; remove to empty, reload/switch, and no form leakage or reseeding.

Structured evidence is `output/playwright/cp2-banner-admin/results.json`. It records 503 version 11 → 12 with an operation-status query; lost-response version 12 → 13 with no second increment; and conflict version 13 → 15 for two remote writes → 16 after reviewed local save. Untouched remote title/caption/hidden/image values are preserved. Retained image assets remain after gallery removal.

### Visual evidence

Fourteen screenshots under `output/playwright/cp2-banner-admin/` were captured; desktop and narrow layouts, controls, title fields, crop and error states were visually inspected:

- `editor-1280.png`, `editor-320.png`, `editor-390.png`
- `editor-320-viewport-top.png`, `editor-320-viewport-fields.png`
- `editor-390-viewport-top.png`, `editor-390-viewport-fields.png`
- `center-crop-preview.png`
- `save-failure-320.png`, `version-conflict-390.png`, `title-limit-error-390.png`
- `image-load-failure-390.png`, `remotely-deleted-draft-390.png`, `empty-banner-390.png`

Viewport assertions confirm no horizontal overflow; all three title input bounds stay inside the 320/390 viewport and the closed sidebar stays offscreen. `uncropped-source.png` and `uncropped-stored-variant.webp` accompany the central crop evidence. Existing gallery/embedded screenshots remain under `output/playwright/`.

## Preservation, limitations and handoff

All 24 migration files retain their starting raw bytes and runner checksums. Migration 024 SHA-256 remains `2d7bd0f91bcd082abef6035c30a968663d843c4219c97bfe97dc9cd4f8253902`. `final-preservation.json` also verifies CP0 content/generated files and generator, migration runner, gallery store/resolver, collection GET, PG test and accepted CP1 report unchanged against the starting hashes.

The API boundary changed as explicitly described above, so the complete API suite was rerun. The file/PG store and migration/upgrade logic were not changed: CP1's nine real PG acceptance cases and evidence remain applicable, and were not unnecessarily rerun. This checkpoint's browser evidence is explicitly file-store evidence, not a new PG claim. The unrelated full E2E suite and other admin modules were not rerun; the original media smoke covers the five public/embedded media areas affected by this editor.

No remaining blocker was found for CP2. Remaining validation belongs to later checkpoints: final homepage container ratio and SSR/controller integration, production database/storage/cache behavior, cross-browser/mobile-device coverage beyond desktop Chromium viewport tests, announcement/calendar cards, deployment and rollout checks. Preview 16:9 remains provisional until the homepage design is finalized. Historical Banner videos, if any, are preserved but cannot be edited/published through a new video put; they can be removed or reordered.

Local evidence under `output/` is ignored by Git; retain/archive that directory separately when sharing this acceptance record. No homepage SSR, homepage controller, resource cards or deployment work was started.
