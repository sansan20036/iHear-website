# Homepage calendar

Administrators add, edit and delete events in `/admin/calendar`; the homepage shows them
beside the hero photo as soon as a save succeeds. Visitors can only view.

## What is stored

- One published document in `site_settings`, key `home_calendar_v1`, with a record version.
  The same pattern as the Academy content (`docs/academy-content.md`).
- `{ schemaVersion: 1, timeZone: "Asia/Taipei", events: [...] }`. Each event has an id, a
  title (120 characters), a date, an optional start and end time, a description (1,000
  characters, line breaks kept) and an optional link (`https://` or `http://` only, with
  an optional label of 60 characters). At most 200 events.
- Times are entered and stored in Taipei time (UTC+8, no daylight saving). The homepage
  shows Taipei time and, for a visitor whose time zone differs at that moment, the local
  time as well. Days on the month grid are Taipei dates.
- Event text is entered once and shown in every site language; only the interface labels
  (weekdays, months, buttons) follow the language switch.
- Migration 027 widens the value limit for `home_calendar_v1` to 400,000 characters (enough
  for 200 events at every limit), adds the `calendar` activity type and seeds an empty
  calendar only when the row is absent. It never changes a saved calendar.
- A hosted deployment without its row answers 503; it never shows an empty calendar in place
  of a missing one. Local development without a database uses `data/home-calendar.json`.

## Requests

- `GET /api/home-calendar`: `{ config, recordVersion }`, `no-store`. Never the editor's
  identity.
- `POST /api/home-calendar`: `{ config, expectedVersion }`. Requires a same-origin request
  and an owner or an enabled editor, resolved again on every save (a disabled editor loses
  access at once). A stale `expectedVersion` answers 409 and changes nothing; a missing one
  428. Each save writes one `admin_activity_log` entry (`calendar.events.updated`, with the
  created, updated and deleted event ids).
- The homepage script (`assets/home-calendar.js`) builds every element with `textContent`
  and accepts only `http(s)` links, opened with `rel="noopener noreferrer"`. An administrator
  also sees a link to `/admin/calendar`.

## Layout

- 1280 px and wider: three columns (text .85fr, photo 1fr, calendar 270 px; the photo is
  425 px wide). The two stat cards on the photo get smaller there, and the English heading is
  capped at 3rem so "Communication" fits its column.
- 1001–1279 px: the calendar moves below the text and photo, with the list beside the month
  (also from 721 px when the hero is one column).
- 720 px and narrower: one column (text, photo, calendar).
- The homepage lists at most two events without their descriptions, and links to the full page.

## The full calendar page (/events)

- A managed public page (`events.html`, the shared header and footer) whose body
  `assets/home-calendar.js` renders from the same `GET /api/home-calendar`: no other data.
- Three layouts of the same events, switched by tabs (arrow keys move between them):
  **Monthly** (titles inside the days; dots and the day's list on a phone), **Agenda**
  (upcoming events by month with a date badge) and **Pinboard** (event cards; one column on a
  phone). Past events sit behind "show past events" in Agenda and Pinboard.
- The choice is kept in `?view=` and in this browser (localStorage, optional); without one a
  phone starts on Agenda and a computer on Monthly. Every layout shows the empty state.
- `/events.html` redirects to `/events` like the other pages; the page is in the sitemap.

## Tests

- `npm run test:calendar`: model, API and local store (37).
- `npm run test:calendar:postgres`: migration 027 and store transactions in a disposable
  localhost-only Docker `postgres:17-alpine` (6).
- `npm run test:calendar:browser`: the built application with test-only sessions.
  `home-calendar.smoke.mjs` (12): layouts at 1440, 1100 and 390 px, add, validate, edit,
  conflict, delete, New York local time, language switch, administrator link, refused writes.
  `home-calendar-views.smoke.mjs` (10): the /events page's three layouts empty and with events
  on a computer and a phone, the remembered choice, and the homepage at eight sizes (1920–390
  px) checked for overlap, sideways scrolling, the stats band and English text in its column.

## Before a production release

1. Take and verify a backup (the restorable-backup tool) and rehearse 027 on the restored
   copy. 027 changes the migration ledger, so the backup tool's post-025/026 checks must
   accept a ledger that also records 027.
2. Apply 027 through the existing runner, then deploy; check the homepage at the three widths
   and that visitors see no admin link.
3. The P3 classroom prototype drafted its own 027; whichever ships second is renumbered.
