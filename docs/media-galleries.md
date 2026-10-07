# Media galleries

Manage galleries at `/admin/media`. Photos use the existing PNG/JPEG/WebP intake and WebP compression; videos use a validated YouTube link. Every completed save is published. A gallery has at most 20 entries, including hidden entries. Tutoring and outreach are each shared between the homepage and Programs. Home, Stories and Impact have separate galleries; empty galleries are hidden.

Signed-in administrators can also select **Manage photos / videos** directly above each public gallery. This opens the existing admin editor in a same-origin dialog with the corresponding gallery and page language selected. Empty galleries expose this entry only to administrators. Saves refresh the public gallery immediately; closing with unsaved drafts requires confirmation and closing during a save is blocked. The full admin page remains available via the dialog link. Only `/admin/media` permits same-origin framing; other routes retain their framing restrictions and all admin APIs retain authentication checks.

Select multiple photos, fill their three-language alternative text, optionally preview translations, then save. Captions are separate and optional. Manually entered Chinese is retained. A missing translated caption displays English without writing it into the Chinese fields. Uploads run sequentially, retain successful items, and pause on rate limits. Failed/uncertain saves keep the operation ID and reconcile against the server before retrying. Refresh a conflicted gallery and review the preserved draft before saving again.

The public frame uses 16:9 with a 200px minimum height and uncropped `contain` images. YouTube iframes are created only on a play click and removed when switching items. Photo URLs are immutable; replacements create new assets. Removing a gallery entry never deletes saved photos. Legacy service image mutation endpoints are blocked after handover to galleries.

## Persistence and deployment

Migration `019_media_galleries.sql` adds galleries, retained assets and idempotency records; it seeds references to current service slots and existing video IDs. It does not update legacy content, images, team records or translations. Gallery mutations and translation provenance commit together in PostgreSQL. Local file mode uses one atomically renamed file with an exclusive lock. `IHEAR_TEST_DATA_DIR` applies only with `IHEAR_FORCE_FILE_STORE=1`, to isolate browser tests.

Unknown database commit outcomes must not trigger image deletion. Inspect the operation record and asset references before cleaning any unreferenced objects. Known rejected uploads clean up their new objects automatically. The gallery upload quota is 30 requests per administrator per 10 minutes; other quotas are unchanged.

Before deployment, run `npm run check`, `npm run db:backup`, and verify the backup using `npm run db:verify-backup-file -- <backup>`. Apply the tracked migration before the code deploys. Then run `node scripts/verify-gallery-deployment.mjs <pre-deployment-backup>` and verify public pages. This check expects legacy tables to remain unchanged and allows the added migration. Investigate any differences; never restore over newer administrator edits.

Backups with format version 9 include all three gallery tables. If code rollback is necessary, retain these tables and photo objects. A pre-gallery code rollback shows the original service images and videos; gallery updates remain stored for a later forward deployment.

## Home banner media contract (CP1)

Migration `024_home_banner_gallery.sql` extends the existing `media_galleries_id_check` with `home-banner`. It preserves the original five gallery IDs, version/items constraints, assets, operation records and legacy item JSON. Items remain embedded in `media_galleries.items`; there is no separate media-items table or title column. The migration introduces an optional `title` property containing `{ en, zhHant, zhHans }` or `null`, without backfilling historical items.

Both stores return missing item titles as `null`. CP2 limits newly entered or changed title strings to 120 characters per language, measured with JavaScript `trim().length`, matching the API. An unchanged historical title is preserved even if it exceeds that limit. The nullable value applies to the whole title; individual locale values must be strings, and empty strings are allowed. An explicit `title: null` clears the title. Omitting `title` preserves the existing value, so older editors can still change visibility, captions or photos without erasing a title. Titles do not replace captions, alternative text, or existing translation provenance.

`home-banner` accepts photos only. Its editor offers photo upload and rejects video mutations at the API boundary. Other galleries retain their existing YouTube support. Previously committed operations remain replayable, and any historical Banner video can still be moved or removed. Version conflicts, operation fingerprints and replay semantics retain the existing behavior.

`GET /api/media-galleries?gallery=home-banner` returns the usual `{ items: [...] }` envelope for that gallery. `gallery_id` is accepted as an alias. Unknown, empty, repeated or conflicting filters return 400. Unfiltered GET remains additive: all five existing galleries plus `home-banner`; public requests exclude hidden items and administrator requests still require authorization. Response cache headers remain `no-store`.

The new gallery is initialized once with a photo reference to `home.hero`, `title: null` and an empty caption. Resolution prefers the current custom site-media asset (including crop and alt text), otherwise the existing static `hero-classroom` image. No image objects or legacy hero settings are copied or changed. A missing file-store gallery is added under the existing exclusive writer lock. PostgreSQL inserts the seed only when its row is absent. Once an administrator removes all entries, reads, restarts and rerunning migration 024 preserve that empty array.

Local PostgreSQL initialization now upgrades an existing 019 schema, using migration 024 under a transaction and advisory lock. Hosted production still requires `npm run db:migrate` before deploying this code. CP1 supplies the API/storage contract; CP2 adds the admin editor described below; CP3 renders the first public Banner on each homepage request; CP4 adds manual carousel controls and refresh integration.

Run `npm run test:media-contract` for file/API compatibility and `npm run test:media-schema` for real PostgreSQL preservation and concurrency checks in a disposable local Docker database. The latter never uses configured deployment database URLs.

## Verification

`npm run check` includes API/storage tests, public browser regressions, production build and `test:media-admin`. The latter runs the existing gallery smoke on loopback port 3212, followed by `test:media-banner-admin` on port 3213. Both start the built app with test-only Auth.js keys and isolated file storage. They check actual compression/upload, lost-response retry, ordering, visibility, removal and mobile layout without production credentials or production writes.

## Home banner admin editor (CP2)

Choose **Homepage Banner · Photos only** at `/admin/media`, or open `/admin/media?gallery=home-banner`. Use the existing photo, edit, order, hidden and remove actions. Hidden photos remain editable. Removing the last photo leaves an empty gallery after refresh or switching collections; the editor never reseeds it.

The Banner editor provides English, Traditional Chinese and Simplified Chinese title fields, independently of the 300-character caption fields. Untouched titles are omitted from save payloads. Changing one language preserves the other two; explicitly clearing all three sends `null`. A preview with a missing translation displays English without copying it into an empty field. After a version conflict, refresh retains edited title locales and loads untouched locales from the latest saved item. Review the preserved draft before saving again. Uncertain saves retain their frozen payload and operation ID until reconciliation.

The admin preview uses `object-fit: cover` and centered positioning; original image variants and stored crop metadata are unchanged. CP3 calibrates two preview modes: **mobile 16:9**, and **desktop at a simulated 1024px viewport**, whose homepage photo frame is **666.4 × 420px**. The desktop preview scales this ratio to the available editor width rather than applying 420px minimum height to the small preview. This is a display setting, not a media contract. Preview titles remain below the image. Failed images retain the frame with an error message. See [the CP2 acceptance report](media-admin-checkpoint-2.md) for the original editor acceptance and [the CP3 report](home-focus-checkpoint-3.md) for calibrated crop comparisons.

## Request-time homepage Banner (CP3)

The dynamic homepage route reads the public `home-banner` projection on every request. A single snapshot supplies its HTML, embedded JSON and first-image preload. Published item order and gallery/image versions are retained; hidden items and admin operation metadata are excluded. Successful empty reads collapse the Banner and expand the three quick-link cards. A failed or invalid read, or a read exceeding one second, retains a readable placeholder and a normal same-page retry link. The deadline stops waiting; the existing store interfaces do not expose cancellation of the underlying read.

The first photo uses a centered crop, responsive sources, explicit dimensions, eager loading and high priority. The former intro photo no longer competes with that preload. Desktop uses a 7:3 grid with 24px gap, a preferred 16:9 image frame and 420px minimum height. Tablet stacks the photo above three cards; below 768px the 16:9 photo and text are separate. Long text can extend the outer Banner without changing the photo crop. Server cookie/header language is immediately readable without JavaScript; parsing-time bootstrap applies browser-only language preferences and display-only English fallback.

The homepage and public media retain `private, no-store, max-age=0` and `Vercel-CDN-Cache-Control: no-store`; versioned images retain one-year immutable caching. `test:home-banner-contract` covers the loader/renderer and preload integration; `test:home-banner-ssr` verifies the built app with isolated data. The quick cards contain their fixed labels and working links; their data, carousel controls and background refresh are not implemented in CP3.

## Manual homepage carousel and refresh (CP4)

The homepage controller adopts CP3's existing DOM and public snapshot. One photo remains static; two or more expose previous/next buttons, item dots, local arrow keys and horizontal touch gestures with wraparound. There is no autoplay. Stable item IDs retain selection across sorting and refresh; if the selected item disappears, the new first public item is selected. Initial HTML reserves the longest text across all public items and languages, so ordinary selection and language changes preserve the photo frame and surrounding layout.

One filtered `gallery_id=home-banner` request runs at a time. Signals received during it coalesce into one follow-up read. The full response, including JSON body, has a five-second browser abort deadline. Gallery versions cannot decrease, including after empty; independent image versions identify decoding work, not gallery ordering. A legal new public set removes withdrawn content immediately, before replacement-image decoding. Failed refreshes retain the last successful ready/empty state. Decoding failures never restore withdrawn photos.

The controller uses the existing `ihear-media-galleries` string notification and embedded-editor bridge, plus shared `iHearLiveContent.register('content')`. It adds only a 15-second visible-page gallery refresh, preserving the shared revision's 10-second poll and three-second CDN TTL. Initial calibration does not depend on the first revision baseline. Focus, online, visibility return, pageshow and manual retry use the same refresh entry. Pagehide disconnects subscriptions and aborts the browser request; returning resumes from current accepted state. No store or SQL cancellation is claimed.

Run `test:home-banner-controller-contract` for controlled request/body/decode ordering and `test:home-banner-controller` for the isolated production-build browser scenarios. See [the CP4 report](home-focus-checkpoint-4.md) for actual results, lifecycle/accessibility boundaries and visual evidence. Quick-card data and deployment remain later checkpoints.
