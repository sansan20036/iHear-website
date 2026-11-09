# Classroom recording test: one TEST- lesson, recorded and filed, on this computer only

`tools/classroom-recording-test/recording-test.mjs` runs the built site on 127.0.0.1 to record one
TEST- lesson and file the recording: to Google Drive with a test account's `drive.file` grant, or to
the site's local stand-in. It is the P1 phase-3 test runner (2026-10-31). It is separate from the P3
trial server (`tools/classroom-trial/trial-server.mjs`), which records nothing and is not changed.

## What protects the test

- **This computer only.** One port on 127.0.0.1 (default 3320). Every answer is marked
  `X-iHear-Recording-Test: local`. `start-tunnel.mjs` points a tunnel only at a port that answers
  `/admin` with 404 and `X-iHear-Trial: public` (the trial server's classroom-only port), so it refuses
  this one. Checked on 2026-10-31: `/admin` here answered 307 without that header.
- **No webhook.** The tutor's page reports the id of the Zoom session it joined (Video SDK
  `getSessionInfo().sessionId`). The server keeps it only as reported, and uses it only after Zoom
  confirms the session is this lesson's: `GET /videosdk/sessions/{id}?type=live`, then
  `?type=past`, checking `session_key` (the lesson id) or `session_name` (the room name).
  - An id Zoom does not know, or knows as another lesson's, is refused. The overview raises it as
    `SESSION_REJECTED`.
  - Switched on here only (`CLASSROOM_SESSION_REPORTS=verify`). The live site and the trial server
    keep it off.
- **TEST- codes only.** The lesson, tutor and student are TEST- codes, and the site's consent route
  takes nothing else.
- **Nothing is recorded until the operator types `RECORD <lesson code>`.** Only then is trial consent
  switched on, and the student's consent and the tutor's recording notice recorded. Any other answer
  leaves the lesson unrecordable.
- **Zoom only with `--real-recording`.** The account owner must approve the test first: cloud
  recording, API keys and the Google grant. LCIC is refused.
- **The vendor's copy is never deleted.** `CLASSROOM_VENDOR_DELETION` stays off. Each filed recording
  records that its vendor copy was kept (`p1.vendor_copy_kept`).
- **No production credential is read.**
  - The Zoom values come from the trial's env file (outside the repository, read by
    `tools/classroom-trial/env-file.mjs`), and are hidden in everything this process prints.
  - The Google grant is two files outside the repository and outside OneDrive.
  - The data is a fresh local folder: the file store, no database server.

## Recording controls (2026-11-08)

- **Recording stops when the lesson is over.** Five minutes after the scheduled end (a grace for the
  last words) the server sends `recording.stop`, again 30 seconds later, and ends the session 60
  seconds later if Zoom still has not confirmed (`LESSON_END_STOP_UNCONFIRMED` is then raised). A
  recording never starts after that cut-off. Leaving the room ends the session sooner.
- **Emergency stop (owners).** The overview's 緊急停止錄影 button, after a confirmation, records
  `server.emergency_stop` and runs the tick at once: `recording.stop` on both channels (the REST call,
  and the tutor's page, which is told recording is no longer allowed), again after 30 seconds, and the
  session is ended after 60 seconds if Zoom has not confirmed (`EMERGENCY_STOP_UNCONFIRMED`). The lesson
  is never recorded again. It protects filing like a withdrawal: a recording that ran past the press
  stays with Zoom and is never uploaded; one that ended before it goes to `_待確認` only.
  `POST /api/admin/classrooms/{lessonId}/stop-recording`, owners only, in the activity log.
- **When this computer's test server has crashed or was closed**, Zoom keeps recording. The independent
  stop needs only the env file and the data folder (the test prints the exact command at start and on
  Ctrl+C):

  ```
  node tools/classroom-recording-test/emergency-stop.mjs --env <file> --data <folder>            (list only)
  node tools/classroom-recording-test/emergency-stop.mjs --env <file> --data <folder> --yes --end
  node tools/classroom-recording-test/emergency-stop.mjs --env <file> --session <id> --yes --end
  ```

  It sends `recording.stop`, with `--end` also ends the session, then asks whether the session is still
  live; `--auth api-key` uses Zoom's `x-api-key` header instead of the site's token. It prints lesson
  codes, shortened session ids and HTTP statuses only.
- **Drive layout.** `[測試] iHear P1 錄影測試 / [iHear] MM.YYYY.Zoom Recordings / <date>_<lesson code> /
  <date>_<students>_<tutor>_Pnn.mp4`; quarantined files in `_待確認`. The STORED (or QUARANTINED) record
  carries the file's name, folder, size, Drive's md5 and file id, and the overview lists each recording
  with them (and a link to the file in Google Drive).
- Tests: `tools/recording-pathway/test/recording-controls.test.mjs`, `tests/classroom-api.test.mjs`
  ("recording controls"), `tests/classroom-emergency-stop.test.mjs`, and the browser check
  `npm run test:classroom:controls` (needs a build).

## Before a real run (each step needs the account owner's approval)

1. Zoom (Platform Studio):
   - Cloud recording on, with only "Record active speaker with shared screen".
   - Automatic recording off.
   - Participants may neither start nor request recording.
   - Display names and chat saving off.
   - "Delete cloud recordings after N days" set.
   - An API key created, and its key and secret put in the env file by the account owner.
2. Google: a Desktop OAuth client in the test project and a sign-in with the P1 test account.
   - Follow `tools/recording-pathway/docs/a1-drive-test-runbook.md` §2.
   - The grant must be exactly `drive.file`, and it expires after 7 days while the project is in
     Testing.
3. Build the site (`node scripts/prepare-public.mjs`, then `npx next build`). On Windows with a
   junctioned `node_modules`, use the webpack two-step build.

## Running it

```
node tools/classroom-recording-test/recording-test.mjs --provider synthetic --drive local --date 2026-11-05 --time 10:00 --check
node tools/classroom-recording-test/recording-test.mjs --provider synthetic --drive local --date 2026-11-05 --time 10:00
node tools/classroom-recording-test/recording-test.mjs --env <file> --real-recording --drive google \
     --google-client <client file> --google-token <token file> --date 2026-11-05 --time 10:00
```

- `--check` names each setting and whether it is filled, never a value, and starts nothing.
- A run adds the lesson, asks for the confirmation, prints the tutor's sign-in link, the student's
  link and the overview link, then runs the scheduled tick every minute and prints the lesson's card
  (codes, statuses and labels only).
- Ctrl+C stops it. Clean-up (Zoom recordings, the Drive test folder, the Google grant and client, the
  data folder) is in `planning/2026-10-31-p1-phase3-precheck.md` §6.6, outside the repository.

A synthetic rehearsal ran on 2026-10-31 against a local build. It added the lesson (201), recorded
both consents after the typed confirmation (200, 200), and ran the tick (200).

## Still to be confirmed with a real recording

- That the Video SDK's `getSessionInfo().sessionId` is the id the REST API takes.
- That the REST JWT (`iss` = API key) is accepted.
- How a session ending shows in `?type=live` and `?type=past`.
- That `file_size` is in bytes (the download's `Content-Range` total is checked against it; a
  difference fails the filing for good and keeps Zoom's copy).
- Range support and redirects on `download_url`.
- How long processing takes.
- Which files Zoom produces.
