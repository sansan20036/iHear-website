# Classroom vendor adapters: Zoom Video SDK and Tencent LCIC (2026-10-30)

Two candidates, no preset order. Both adapters are written from the vendors' documentation and
tested against stand-ins only: **neither has run against a real account, and no real video has
been connected.** The synthetic stand-in remains the only provider that runs locally.

## What is built

| Part | Zoom Video SDK | Tencent LCIC |
|---|---|---|
| Server (`lib/classroom-vendors/`) | Join token (the Video SDK JWT P3 already built), REST token, recording start/stop (`PATCH …/events`), end session (`PUT …/status`), snapshot, ranged download of a listed file | TC3-signed API calls; per lesson: `RegisterUser` ×2 (OriginId = our participant id), one `CreateRoom` (`SubType videodoc`, `TeacherId`, `DisableRecord` from the consent decision), `LoginUser`; ranged download from `DescribeRoom`'s `RecordUrl` |
| Browser (`lib/classroom-media.ts`) | `ZoomVideoSdkMediaAdapter`: init, join with the token's topic and the participant code as name, audio/video, remote state and user key, video tiles | `LcicEmbedAdapter`: places Tencent's classroom page (only `https://www.tencentclass.com/latest/class.html`) in an iframe with camera/microphone allowed |
| Notices | Existing Zoom webhook route | `POST /api/classroom/lcic/callback`: md5(callback key + expiry), events turned into the same facts as Zoom's |
| Recording → P1 filing | Existing path | `RecordFinish` → one `lcic_mixed` file → the same dedupe, consent check and Drive filing |
| Room page | Vendor stage for Zoom's tiles | Tencent's page replaces our stage and device buttons |
| Both | "Limits on this device" card from `lib/classroom-capabilities.ts` (computer, tablet, phone) | |

Entry, roles, consent and the owner overview are P3's, unchanged: the join check decides who
enters, the recording decision decides whether anything is recorded.

## Still simulated or not built

- **Zoom:** the npm package `@zoom/videosdk` is not installed; until it is, joining says "not
  connected". The whiteboard and screen share are not wired yet. Removing a person and deleting
  a recording have no documented REST call (they answer 501). PDF/PPT: Zoom has no import, so it
  is screen sharing from a computer, or a PDF viewer iHear would build.
- **LCIC:** recording is fixed when the room is created; starting or stopping it mid-class, ending
  a class and removing a person are not documented (501). So a consent withdrawal during an LCIC
  class can only be raised as an error for a person to handle. The lesson-to-room map is a local
  file; a hosted site needs a table first (the provider refuses to run on Vercel until then).
- **Both:** `vercel.json` still sends `camera=(), microphone=()` for every page, and the CSP does
  not allow the vendors' domains. `/classroom` needs its own headers with the vendors' exact
  domain lists, taken from their docs during the trial.

## What the trial must confirm

The order follows the acceptance points:

1. Entry from iHear Academy.
2. One-to-one video in Taiwan and the US.
3. PDF and PPT.
4. The whiteboard by role.
5. Computer, tablet and phone.
6. Consent and keeping the recording after class.
7. Ease of use for the teacher.

Field-level checks:
- Zoom: the participant's `userIdentity`/`userKey` value; the `recording_completed` fields and download auth.
- LCIC: `RegisterUser` fields; `MemberJoin`/`MemberQuit` fields; the unit of `RecordSize`; whether a failed callback is retried; whether a student can be given drawing rights; mobile browsers.

## Configuration (names only; values are never committed)

- Zoom: `CLASSROOM_PROVIDER=zoom-video-sdk`, `ZOOM_VIDEO_SDK_KEY`, `ZOOM_VIDEO_SDK_SECRET`,
  `ZOOM_VIDEO_SDK_API_KEY`, `ZOOM_VIDEO_SDK_API_SECRET`, `ZOOM_VIDEO_SDK_WEBHOOK_SECRET`.
- LCIC: `CLASSROOM_PROVIDER=tencent-lcic`, `LCIC_SDK_APP_ID`, `TENCENTCLOUD_SECRET_ID`,
  `TENCENTCLOUD_SECRET_KEY`, `LCIC_CALLBACK_KEY`.

## Tests

- `tests/classroom-vendors.test.mjs` (vitest) covers both servers and both browser adapters, plus the device limits.
  - The TC3 canonical request and the callback md5 match Tencent's documented examples.
  - The final TC3 signature and every HTTP answer are stand-ins.
- `tools/recording-pathway/test/lcic-callback.test.mjs` (node --test) covers LCIC events into the store and P1 filing, with and without consent.
