# Media galleries

Manage galleries at `/admin/media`. Photos use the existing PNG/JPEG/WebP intake and WebP compression; videos use a validated YouTube link. Every completed save is published. A gallery has at most 20 entries, including hidden entries. Tutoring and outreach are each shared between the homepage and Programs. Home, Stories and Impact have separate galleries; empty galleries are hidden.

Select multiple photos, fill their three-language alternative text, optionally preview translations, then save. Captions are separate and optional. Manually entered Chinese is retained. A missing translated caption displays English without writing it into the Chinese fields. Uploads run sequentially, retain successful items, and pause on rate limits. Failed/uncertain saves keep the operation ID and reconcile against the server before retrying. Refresh a conflicted gallery and review the preserved draft before saving again.

The public frame uses 16:9 with a 200px minimum height and uncropped `contain` images. YouTube iframes are created only on a play click and removed when switching items. Photo URLs are immutable; replacements create new assets. Removing a gallery entry never deletes saved photos. Legacy service image mutation endpoints are blocked after handover to galleries.

## Persistence and deployment

Migration `019_media_galleries.sql` adds galleries, retained assets and idempotency records; it seeds references to current service slots and existing video IDs. It does not update legacy content, images, team records or translations. Gallery mutations and translation provenance commit together in PostgreSQL. Local file mode uses one atomically renamed file with an exclusive lock. `IHEAR_TEST_DATA_DIR` applies only with `IHEAR_FORCE_FILE_STORE=1`, to isolate browser tests.

Unknown database commit outcomes must not trigger image deletion. Inspect the operation record and asset references before cleaning any unreferenced objects. Known rejected uploads clean up their new objects automatically. The gallery upload quota is 30 requests per administrator per 10 minutes; other quotas are unchanged.

Before deployment, run `npm run check`, `npm run db:backup`, and verify the backup using `npm run db:verify-backup-file -- <backup>`. Apply the tracked migration before the code deploys. Then run `node scripts/verify-gallery-deployment.mjs <pre-deployment-backup>` and verify public pages. This check expects legacy tables to remain unchanged and allows the added migration. Investigate any differences; never restore over newer administrator edits.

Backups with format version 9 include all three gallery tables. If code rollback is necessary, retain these tables and photo objects. A pre-gallery code rollback shows the original service images and videos; gallery updates remain stored for a later forward deployment.

## Verification

`npm run check` includes API/storage tests, public browser regressions, production build and `test:media-admin`. The admin smoke test starts the built app on loopback port 3212 with a test-only Auth.js key and isolated file storage, then checks actual compression/upload, lost-response retry, ordering, visibility, removal and mobile layout. It does not use production credentials or write production data.
