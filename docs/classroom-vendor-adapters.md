# Classroom vendor adapters: Zoom Video SDK and Tencent LCIC (2026-10-30)

Two candidates, no preset order. **Neither has run against a real account, and no real video has
been connected.** Each part below is marked as one of three kinds:

- **real package:** works with the vendor's official code;
- **stand-in:** written from the vendor's reference and tested with stand-ins;
- **needs an account:** can only be shown with a trial account.

The branch is `feat/p3-classroom-live`, rebuilt on the live site `1091662` (calendar and migration
027); the classroom migration is 028 and keeps 027's `calendar` activity type.

## What is built

| Part | Zoom Video SDK | Tencent LCIC |
|---|---|---|
| Package | **Real package:** `@zoom/videosdk` 2.6.0 (exact), loaded in the browser only when a Zoom room opens. TypeScript checks every call the adapter makes against the package's own types (`OfficialZoomSdk`) | No package: Tencent's classroom page in an iframe |
| Browser | **Real package, checked in Chromium** (`npm run test:classroom:zoom-sdk`): the package loads under the classroom CSP, Zoom's browser check answers, and Zoom's `<video-player-container>` elements are defined and used. **Needs an account:** joining, audio and video, screen share and the whiteboard. Wired: video tiles; the tutor's screen share (materials) with the other side's view; the whiteboard (host starts, the other person views, PDF export); a pre-join device check | **Stand-in:** places only `https://www.tencentclass.com/latest/class.html` in an iframe with camera and microphone allowed |
| Server | **Stand-in:** join JWT, REST JWT, recording start/stop (`PATCH …/events`), end session (`PUT …/status`), snapshot, ranged download | **Stand-in:** TC3-signed calls. `RegisterUser`, `CreateRoom` (`DisableRecord` 1 = never or 2 = manual), `LoginUser`, `StartRecord` (task id kept), `StopRecord`, `EndRoom` (the next entry opens a new room, decided again), `KickUserFromRoom` (KickType 2), `DeleteRecord`, `DescribeRoom`. Tencent error codes become statuses (404, 409, 501, 403, 502) |
| Notices | Existing Zoom webhook route | `POST /api/classroom/lcic/callback`: md5(callback key + expiry); `RecordFinish` → P1 filing |
| Headers | `vercel.json` rule `/classroom/:lessonId`: the CSP allows `source.zoom.us` (script, worker) and `zoom.us` plus `*.zoom.us` (connect; the join calls `https://zoom.us/wc/lsdk`, found by the real-package check); Permissions-Policy allows camera, microphone, screen capture and fullscreen for the page itself | The same rule: `frame-src https://www.tencentclass.com`, and camera, microphone, screen capture, fullscreen and clipboard delegated to that origin |

The rest is P3's and unchanged:
- entry, roles, the join check and the recording decision;
- the owner overview;
- P1 filing.

Every other page keeps `camera=(), microphone=()`. Vercel applies the later rule's header (seen live on `/admin/media`).

## Recording safety

- **Zoom:** only the server starts and stops cloud recording (REST). Cloud recording needs a paid Zoom plan, so it is untested.
- **LCIC:**
  - A room records only if the server allowed it before creating the room, and then only in manual mode: nothing records before `StartRecord`.
  - `StartRecord` and `StopRecord` are documented only on Tencent's China site (2025-09-12), so whether they work on the international service is **unknown**, and no callback confirms a stop.
  - A stop is therefore never treated as confirmed. The service's withdrawal steps end the class (`EndRoom`) when no confirmation comes, and the next entry opens a new room that never records.
  - **Until a trial shows that a mid-class stop works (`LCIC_MIDCLASS_STOP_VERIFIED=1`), only lessons whose every participant is a `TEST-` code can be recorded through LCIC.** Real students cannot.
- **Test consent:**
  - Outside the synthetic stand-in, consent stays `POLICY_PENDING` (Justine's policy).
  - In a vendor trial, `CLASSROOM_TRIAL_CONSENT=1` lets the owner set test consent for `TEST-` codes only, never in production.

## Still not built or not verifiable without an account

- **Zoom:**
  - joining a real session;
  - the `userKey`/`userIdentity` value Zoom reports;
  - the whiteboard's account setting and drawing rights;
  - the CSP domains the whiteboard needs beyond `*.zoom.us`: read the browser console in the trial and add exactly what it reports;
  - cloud recording (paid add-on).
  - Removing a person and deleting a recording have no documented REST call (501).
  - SharedArrayBuffer (cross-origin isolation) is not enabled; Zoom works without it.
- **LCIC:**
  - every API answer;
  - `StartRecord`/`StopRecord` on the international service;
  - drawing rights for a student;
  - mobile browsers.
  - The lesson-to-room map is a local file; a hosted site needs a table first (the provider refuses to run on Vercel until then).

## Configuration (names only; values are never committed)

- **Zoom:** `CLASSROOM_PROVIDER=zoom-video-sdk`, `ZOOM_VIDEO_SDK_KEY`, `ZOOM_VIDEO_SDK_SECRET`, `ZOOM_VIDEO_SDK_API_KEY`, `ZOOM_VIDEO_SDK_API_SECRET`, `ZOOM_VIDEO_SDK_WEBHOOK_SECRET`.
- **LCIC:** `CLASSROOM_PROVIDER=tencent-lcic`, `LCIC_SDK_APP_ID`, `TENCENTCLOUD_SECRET_ID`, `TENCENTCLOUD_SECRET_KEY` (a sub-user limited to LCIC), `LCIC_CALLBACK_KEY`.
  - `LCIC_MIDCLASS_STOP_VERIFIED=1` only after a trial has shown the stop works.
- **Trial only:** `CLASSROOM_TRIAL_CONSENT=1` (`TEST-` codes; refused in production).

## Tests

- **`tests/classroom-vendors.test.mjs`** (vitest) covers both servers and both browser adapters, plus the device limits.
  - LCIC: each control call with its parameters, the recording rule for real and test lessons, and the error statuses.
  - Zoom: the containers, materials, whiteboard and system check.
  - The TC3 canonical request and the callback md5 match Tencent's documented examples. Every HTTP answer is a stand-in.
- **`tests/classroom-zoom-sdk.smoke.mjs`** loads the real package in Chromium under the checked-in headers.
  - Only `source.zoom.us` is reachable, so the local stand-in key cannot reach a Zoom session server.
- **`tests/operations-config.test.mjs`** checks that only the classroom page gets camera, microphone and the vendor domains.
- **`tools/recording-pathway/test/lcic-callback.test.mjs`** (node --test) covers LCIC events into the store and P1 filing.
