# Online classroom (P3 MVP)

One-to-one lessons in a classroom on the website, cloud recording that starts only after the
whole roster's consent is confirmed, filing of finished recordings through P1's naming rules,
and a live overview for owners.

**Everything here is synthetic.** No video service has been chosen: Tencent RTC, Agora and the
Zoom Video SDK are all still candidates. The provider is a synthetic stand-in with no audio or
video (its webhooks are shaped like Zoom's because the first design targeted Zoom), and the
recording destination is a local folder standing in for Google Drive. Consent records are synthetic
until Justine approves the consent policy. A synthetic pass shows that our own logic is
right. It does not show real Zoom behaviour, delays, how many recordings can run at once,
cost or device support; those are accepted separately against real Zoom.

## Pages and routes

| Path | Who | What |
|---|---|---|
| `/classroom/[lessonId]` | Student with the personal link (`?k=`); the lesson's tutor, signed in | Enter the classroom: lesson facts, the video stage, camera and microphone controls, the connection state and a recording badge for both people. The tutor's page reports a heartbeat and connection changes and shows the recording detail; the student's page shows whether the lesson is being recorded. In the synthetic setup a "simulation controls" panel plays the other person entering or leaving, a dropped or failed connection, and a blocked camera or missing microphone |
| `/admin/classrooms` | Owners | Live overview, problem records with handling, adding lessons, synthetic consent |
| `POST /api/classroom/[lessonId]/join` | Anyone; same origin, rate limited | Identity, roster and time window only, never consent; issues the provider token |
| `POST /api/classroom/[lessonId]/host-events` | The lesson's tutor | Stores the report, runs the lesson's tick, answers whether recording is allowed |
| `POST /api/classroom/[lessonId]/status` | The student with the personal link; the lesson's tutor, signed in; same origin, rate limited | The recording state for the people in the room, read every 15 s by the student's page. Same identity, roster and time-window check as entering; it stores nothing, issues nothing and answers with codes only |
| `POST /api/recordings/zoom/webhook` | The provider, signed | Verifies, minimizes and stores the event with its jobs in one transaction, then answers; the lesson's tick runs after the response |
| `GET`/`POST /api/admin/classrooms` | Owners | Overview (codes only, `mode` says when it is synthetic); add a lesson (the link is returned once) |
| `POST /api/admin/classrooms/tick` | Owners | The periodic work, also run by the open overview every 15 s |
| `POST /api/admin/classrooms/[lessonId]/reconcile` | Owners | "Check now" against the provider |
| `POST /api/admin/classrooms/anomalies` | Owners | Record how a problem was handled |
| `POST /api/admin/classrooms/consents` | Owners, synthetic setup only | Synthetic consent and tutor notice; `403 POLICY_PENDING` otherwise |

## The video provider interface

The classroom page talks to video only through `lib/classroom-media.ts`, so the chosen SDK
becomes one more adapter and the page does not change:

- `ClassroomMediaAdapter`: `join` (with the session token from the join check), `leave`,
  `setDevice(camera | microphone, on)` and `subscribe` to connection, device and
  other-person events. `capabilities.realMedia` says whether it carries real audio and video.
- `createMediaAdapter(provider)` returns the synthetic adapter for `synthetic` and refuses
  `tencent-rtc`, `agora` and `zoom-video-sdk` ("not built yet"); the page then says the video
  is not connected. Any other name is refused as unknown.
- `hostReportFor(event)` turns an adapter event into the tutor's existing report
  (`Connected`, `Reconnecting`, `Closed`, `Fail`; joins and leaves only with a user key).
- Recording is not part of it on purpose: only the server starts and stops recording, after the
  consent check.

The server side is `ClassroomProvider` in `lib/classroom-provider.ts` (session token, start and
stop recording, end the session, remove someone, snapshot, download a byte range, delete a
recording). Both sides use the same provider names. The synthetic adapter never asks the
browser for a camera or microphone and never makes a network request.

## Where the rules live

The rules are plain JavaScript shared with the P1 prototype and tested with `node --test`:

- `tools/recording-pathway/classroom/eligibility.mjs`: join and recording eligibility, session token claims.
- `tools/recording-pathway/classroom/webhook-ingest.mjs`: webhook verification, minimization, semantic dedupe keys, leased jobs and idempotent filing through P1's `Core.js`.
- `tools/recording-pathway/classroom/lesson-state.mjs`: lesson state from events, the next actions (start, the protective stop, end, remove), reconciliation.
- `tools/recording-pathway/classroom/live-dashboard.mjs`: overview cards and labels.

The website connects them to storage (`lib/classroom-store.ts`), the provider
(`lib/classroom-provider.ts`), the recording destination (`lib/classroom-drive.ts`) and
the routes (`lib/classroom-service.ts`).

The recording decision is re-made while nobody is in the room yet, after any consent or
tutor-notice change. Once anyone is in, it stands for the rest of the lesson.

## Data

Migration `028_classroom_mvp.sql` (027 is the homepage calendar, `feat/home-calendar`), not applied to production:

- `classroom_lessons`, `classroom_participants`: codes only. Tutors are matched by their sign-in e-mail; for students only the hash of the personal link is kept.
- `classroom_consents`, `classroom_staff_notices`: synthetic until the consent policy is approved.
- `classroom_join_tokens`: token hash and expiry, never the token.
- `classroom_events`: minimized facts keyed by meaning; the overview is derived from them.
- `classroom_jobs`: filing and vendor-copy deletion under a lease with a fencing number.
- `classroom_recording_files`: one row per provider file.
- `classroom_anomalies`: kept after they clear. `opened_at` marks the current occurrence; handling before it no longer counts.

Without `POSTGRES_URL`/`DATABASE_URL`, or with `IHEAR_FORCE_FILE_STORE=1`, the store is
`data/classroom.json` (or `IHEAR_TEST_DATA_DIR`), with the same guarantees.

## Configuration

| Variable | Week 1 value | Notes |
|---|---|---|
| `CLASSROOM_PROVIDER` | `synthetic` | Unset closes the classroom: join, tick and webhook answer 503. `zoom` is added in week 2 after credentials are approved. The synthetic provider refuses production. |
| `CLASSROOM_DRIVE` | `local` | Files go to `synthetic-drive/` in the data folder. `google` is added after a test account's authorization is approved. Refuses production. |
| `CLASSROOM_WEBHOOK_SECRET` | any test value | Without it the webhook answers 503. |
| `CLASSROOM_SYNTHETIC_SECRET` | any test value | Signs synthetic session tokens; a per-process random value when unset. |
| `CLASSROOM_CONSENT_VERSION`, `CLASSROOM_STAFF_NOTICE_VERSION` | unset (`synthetic-2026-11`) | Set to the approved versions once the policy exists. |

Local run: `CLASSROOM_PROVIDER=synthetic CLASSROOM_DRIVE=local CLASSROOM_WEBHOOK_SECRET=local-only npm run dev:local`, then open `/admin/classrooms` with an owner session. The browser check (`tests/classroom.smoke.mjs`) uses test-only sessions and never a real Google sign-in.

Demonstration: after a build, `npm run demo:classroom` starts the built site with disposable
local storage and test-only sessions, sets up four lessons (recording; not recorded because the
student has no consent; waiting to start; consent withdrawn in class) and opens the overview,
the tutor's classroom and the student's classroom on a phone-sized window. Ctrl+C ends it.
`IHEAR_DEMO_SECONDS=20 IHEAR_HEADED=0` runs it briefly without windows and leaves screenshots.

## Periodic work

The tick (decide, start or stop recording, reconcile, file) runs on:

- the tutor's heartbeat, every 30 s, or every 10 s while recording;
- the open overview, every 15 s;
- each stored webhook, after the response;
- `GET /api/classroom/scheduled-tick` with `Authorization: Bearer <CRON_SECRET>` (503 without a secret of at least 32 characters). Nothing calls it yet.

Ticks inside a request give filing 10 s; the scheduled tick gives it 50 s of its 60 s. Recordings move to Drive in chunks, with the confirmed byte saved after each chunk, so a recording that does not fit carries on in the next tick, and a function stopped mid-way loses nothing. Lessons with filing still open stay in the overview and the scheduled tick after their day. Design, the Drive cases and the synthetic acceptance: `tools/recording-pathway/docs/p1-auto-filing.md`.

Calling the scheduled tick every minute needs a decision (Supabase `pg_cron` + `pg_net`, or Vercel Pro; Hobby cron runs once a day at most). Until then, the pilot keeps the overview open (see `classroom-pilot-monitoring.zh-TW.md`).

## Tests

| Script | What |
|---|---|
| `npm run test:recording-pathway` | The shared rules and P1's pathway (`node --test`), including automatic filing: functions stopped at every step, a full Drive, retries, duplicates |
| `npm run test:classroom` | Routes and the file store, synthetic, including a recorded lesson end to end, consent rules, the withdrawal stop, the scheduled tick and the room's recording state; and the media adapter interface with its synthetic stand-in |
| `npm run test:classroom:postgres` | Migration 028 and the PostgreSQL store on a disposable local PostgreSQL (Docker, `--pull=never`), the same store contract, and two workers racing on one filing |
| `npm run test:classroom:browser` | The built site in a browser: owner and editor access, adding a lesson, student and tutor entry, the recording state on both pages, a withdrawal, handling a problem, camera and microphone controls, a dropped and a failed connection shown on the overview, a blocked camera, phone layouts, no external requests and no camera or microphone request. Run `npm run build` first. |

On Windows, `next build` with Turbopack can fail with "failed to create junction point ...
(os error 80)". Delete `.next` and build again; it can take several attempts.

## Before a real video SDK goes in

- Choose the service (Tencent RTC, Agora or the Zoom Video SDK) after the vendors' written answers and the cross-region tests (kept outside the repo).
- Write that service's browser adapter (`ClassroomMediaAdapter`): the real camera and microphone, the other person's picture and sound, their user key on joins and leaves, reconnects, mobile background and lock screen, and what the page says in a browser that cannot publish (for example an in-app browser).
- Write its server provider (`ClassroomProvider`): session tokens in the service's format, server-only recording start and stop with the service's automatic recording off, removing a participant, ending the session, snapshots for reconciliation, byte-range downloads and deleting the service's copy.
- Put the Zoom-shaped webhook checks (`verifyZoomRequest`, `minimizeZoomEvent`, the `zoom_*` source names and the `/api/recordings/zoom/webhook` route) behind the chosen provider. The stored event shapes and the P1 filing core stay as they are.
- Accept it against the real service separately; synthetic passes prove only our own logic.

## Before production

- The chosen video service's adapter and provider on the classroom page, accepted against the real service.
- Google Drive adapter (`drive.file`), accepted with a test account.
- `vercel.json`: `/classroom` needs camera and microphone (all routes have them off today) and the SDK's domains in the CSP.
- Backups and restore tooling include the classroom tables; the database audit expects them.
- The approved consent policy and versions; consent entry for real records.
- Reissuing a student link and cancelling a lesson (not in week 1).
- A per-minute caller for the scheduled tick, and `CRON_SECRET` in Vercel.
- Where recordings are stored and how much space that needs (a personal Google account has 15 GB).
