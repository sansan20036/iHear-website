# Online classroom (P3 MVP)

One-to-one lessons in a classroom on the website, cloud recording that starts only after the
whole roster's consent is confirmed, filing of finished recordings through P1's naming rules,
and a live overview for owners.

**Week 1 is synthetic.** The provider is a synthetic stand-in for Zoom, and the recording
destination is a local folder standing in for Google Drive. Consent records are synthetic
until Justine approves the consent policy. A synthetic pass shows that our own logic is
right. It does not show real Zoom behaviour, delays, how many recordings can run at once,
cost or device support; those are accepted separately against real Zoom.

## Pages and routes

| Path | Who | What |
|---|---|---|
| `/classroom/[lessonId]` | Student with the personal link (`?k=`); the lesson's tutor, signed in | Enter the classroom; the tutor's page reports a heartbeat and shows the recording state |
| `/admin/classrooms` | Owners | Live overview, problem records with handling, adding lessons, synthetic consent |
| `POST /api/classroom/[lessonId]/join` | Anyone; same origin, rate limited | Identity, roster and time window only, never consent; issues the provider token |
| `POST /api/classroom/[lessonId]/host-events` | The lesson's tutor | Stores the report, runs the lesson's tick, answers whether recording is allowed |
| `POST /api/recordings/zoom/webhook` | The provider, signed | Verifies, minimizes and stores the event with its jobs in one transaction, then answers; the lesson's tick runs after the response |
| `GET`/`POST /api/admin/classrooms` | Owners | Overview (codes only, `mode` says when it is synthetic); add a lesson (the link is returned once) |
| `POST /api/admin/classrooms/tick` | Owners | The periodic work, also run by the open overview every 15 s |
| `POST /api/admin/classrooms/[lessonId]/reconcile` | Owners | "Check now" against the provider |
| `POST /api/admin/classrooms/anomalies` | Owners | Record how a problem was handled |
| `POST /api/admin/classrooms/consents` | Owners, synthetic setup only | Synthetic consent and tutor notice; `403 POLICY_PENDING` otherwise |

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

Migration `027_classroom_mvp.sql`, not applied to production:

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
| `npm run test:classroom` | Routes and the file store, synthetic, including a recorded lesson end to end, consent rules, the withdrawal stop and the scheduled tick |
| `npm run test:classroom:postgres` | Migration 027 and the PostgreSQL store on a disposable local PostgreSQL (Docker, `--pull=never`), the same store contract, and two workers racing on one filing |
| `npm run test:classroom:browser` | The built site in a browser: owner and editor access, adding a lesson, student and tutor entry, the recording state, a withdrawal, handling a problem, phone layouts, no external requests. Run `npm run build` first. |

On Windows, `next build` with Turbopack can fail with "failed to create junction point ...
(os error 80)". Delete `.next` and build again; it can take several attempts.

## Before production

- Zoom provider and the Video SDK on the classroom page, accepted against real Zoom.
- Google Drive adapter (`drive.file`), accepted with a test account.
- `vercel.json`: `/classroom` needs camera and microphone (all routes have them off today) and the SDK's domains in the CSP.
- Backups and restore tooling include the classroom tables; the database audit expects them.
- The approved consent policy and versions; consent entry for real records.
- Reissuing a student link and cancelling a lesson (not in week 1).
- A per-minute caller for the scheduled tick, and `CRON_SECRET` in Vercel.
- Where recordings are stored and how much space that needs (a personal Google account has 15 GB).
