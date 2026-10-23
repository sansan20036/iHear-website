# Academy course content

The Academy course pages (`/academy/courses`, `/academy/courses/zh`) take their
prices and editable text from one published document. Administrators edit it in
`/admin/academy` or with the ✎ buttons on the course pages; both use the same API.
Course pages are English and Traditional Chinese only.

## What is stored

`site_settings` row `academy_content_v2` (JSON, at most 60,000 characters):

- `pricing.rates`: eight single-session prices, NT$ and US$ for 45 and 60 minutes
  and for the high-school and college tutor. NT$ and US$ are set separately and are
  never converted.
- `content.en` and `content.zhHant`: the text of every element marked
  `data-academy-field` in `academy-site/index.html` and `academy-site/zh/index.html`
  (144 and 140 fields; list and defaults in `data/academy-fields.json`).

Prices are whole currency units (TWD 1–100,000, USD 1–5,000). A ten-session package
is single × 10 × 90%, which is a whole number for every whole-number price, so it is
calculated, never stored, and never rounded. Every price sentence on the pages (price
card, tutor options, no-JavaScript table, pricing FAQ) is generated from these rates by
`lib/academy-pricing-text.ts`; no page text holds a price.

Program-managed and not editable: navigation and section anchors, language switch,
header button, currency/length/plan labels, the email address and `mailto:` links,
title and meta description, tutor point numbers, and the price sentences themselves.

## Changing an editable field

1. Mark the element in the template with `data-academy-field="<block>.<part>"` inside
   an element with `data-academy-block`. Fields hold text and `<br>` only.
2. Run `npm run academy:fields -- --write` and commit `data/academy-fields.json`.
3. A published document keeps working: a new field shows its template text until it
   is edited; a removed field is dropped at the next publication.

## Requests

| Route | Access | Notes |
| --- | --- | --- |
| `GET /academy/courses`, `/academy/courses/zh` | Public | One uncached read per request. If the read fails: HTTP 503, template text, no prices. |
| `GET /api/academy-content` | Public | Published document and version; no identity or audit data. |
| `POST /api/academy-content` | Administrator | Publishes `{ config, expectedVersion }`. |
| `POST /api/academy-content/preview` | Administrator | Renders a draft with the page renderer; stores nothing. |
| `GET /api/admin/me` | Signed-in | 200 administrator, 401 no or expired session, 403 no role. |

Writes require, in order: an `Origin` header equal to the site origin, an Auth.js
Google session whose email resolves to an owner or an enabled database editor (see
[Who can edit](#who-can-edit); checked on every request, so revocation is immediate),
the admin rate limit, `application/json` of at most 256 KiB, and a complete valid
document. Errors:
401 `SIGN_IN_REQUIRED`, 403 `FORBIDDEN` or `ORIGIN_NOT_ALLOWED`, 409
`CONTENT_VERSION_CONFLICT`, 428 `CONTENT_VERSION_REQUIRED`, 400 `CONTENT_INVALID_INPUT`
(with `field` and `reason`), 413, 415, 429, 503 `CONTENT_UNAVAILABLE`.

A publication is one transaction: lock the row, update it only if its version still
matches, and insert an `admin_activity_log` entry (`academy.content.updated`, the
changed field names, the new version). Any failure rolls all of it back.

Course pages are marked `data-academy-admin="available"` only when the server
resolves the visitor as an administrator; only then does the page script check
`/api/admin/me` and add the ✎ buttons. Visitors never contact admin routes. The mark
grants nothing: the API checks access itself.

## Who can edit

- **Owners** come from the first of these that is set: `AUTH_OWNER_EMAILS`, then
  `AUTH_ADMIN_EMAILS`, then the built-in list in `lib/admins.ts`. Only that one list
  applies; the lists are never merged, so adding `AUTH_OWNER_EMAILS` replaces the
  `AUTH_ADMIN_EMAILS` owners entirely. A variable that is set but empty gives no owners.
  The production project sets only `AUTH_ADMIN_EMAILS` (checked 2026-10-24), so that
  list defines its owners.
- **Editors** are the enabled accounts in Admin accounts (`admin_accounts`), which
  owners manage.

## Database

- **025** (`academy_pricing_v1`, an earlier prototype model) is kept byte-identical
  to the reviewed file (normalized checksum `1c0e2ff7…d603de`) because other
  environments may have recorded it. Release evidence shows it is not applied in
  production.
- **026** widens the value limit for `academy_content_v2` only (other keys keep 500
  characters; `academy_pricing_v1` keeps 8,000), repeats 025's `academy` activity
  type, and inserts the P0 prices and the template text **only if the row is absent**.
  It never updates an existing row or its version. It deletes 025's untouched seed
  (`record_version = 1`, `updated_by = 'migration-025'`), whose prices predate P0, and
  keeps an edited `academy_pricing_v1` row for manual review; it is never converted
  automatically.
- **Defaults versus stored values:** the code defaults (`P0_ACADEMY_RATES` and the
  template text) are used to seed an absent row and by local file-store development.
  A hosted deployment with a missing or invalid row shows no prices; it never falls
  back to defaults.
- **Rollback:** 026 is additive, so redeploying the previous application needs no
  database change (the previous code does not read the row). To restore earlier
  content, republish it; the activity log lists each version's changed fields, and the
  encrypted backups contain the row. No down-migration is provided, because reverting
  the activity type would require deleting audit history.
- `db:backup`, `db:verify-backup`, `db:verify-backup-file` and `db:audit` require
  exactly one valid `academy_content_v2` row once 026 is recorded.

## Tests

- `npm run test:academy`: model, page rendering, API, local store, backup checks.
- `npm run test:academy:postgres`: migrations 001–026 and store transactions in a
  disposable localhost-only Docker `postgres:17-alpine`.
- `npm run test:academy:browser`: the editor and the ✎ flow against the built
  application with the `vercel.json` headers applied, using test-only sessions.

## Before a production release

1. Confirm the production database identity read-only and take and verify a backup.
2. Rehearse 025 + 026 on a restored copy; confirm the seeded row equals the P0 prices.
3. Apply migrations through the existing runner, then deploy; check both course pages
   (prices, FAQ, no ✎ for visitors) and `test:production`.
4. Confirm the administrators who should edit (owners from the list described in
   [Who can edit](#who-can-edit), currently `AUTH_ADMIN_EMAILS` in production; editors in
   Admin accounts) and have one of them publish a small change and revert it.
