# Classroom trial server: a closable, access-restricted HTTPS classroom for vendor trials

For round 1 of the Zoom Video SDK and Tencent LCIC trials (2026-10-30): two adult testers, one in Taiwan and one in the US, with test identities only and **no recording**.

The trial runs on this computer, and the outside world sees only the classroom. Every part below has a local test in `tests/classroom-trial-server.smoke.mjs`, which uses the synthetic stand-in and opens no tunnel.

## The pieces

| File | What it does |
|---|---|
| `tools/classroom-trial/trial-server.mjs` | Runs the built site with two listeners, both on `127.0.0.1`. **Public** (3310) is the only port a tunnel may use. **Local** (3311) is for this computer only. |
| `tools/classroom-trial/new-lesson.mjs` | Adds a `TEST-` lesson through the local port and prints the tutor's and the student's personal links, once. |
| `tools/classroom-trial/start-tunnel.mjs` | Opens a Cloudflare Quick Tunnel to the public port, limited by `--allowed-mail`: Cloudflare sends each visitor a one-time PIN. `--dry-run` prints the command without opening anything. |

## What protects the trial

- **Tunnel layer:**
  - Only the listed email addresses get past Cloudflare's PIN page.
  - The `trycloudflare.com` address is random and lives only while the tunnel runs.
  - No Cloudflare account or domain is used.
- **Public port, classroom only:**
  - The room page, its three APIs (join, status, host-events), the site's static files and the theme start-up script.
  - Everything else answers 404: the home page, `/admin`, `/api/admin`, `/api/auth` (no Google sign-in) and the other APIs.
- **Personal links:**
  - A browser gets access to the public port only by opening its personal link. Wrong or missing links answer 404.
  - The student's link is the lesson's own entry key.
  - The tutor's link is a trial sign-in link that gives a staff session for that lesson's tutor, so Google sign-in is not needed on the tunnel's address.
  - Links expire an hour after the lesson ends.
  - The server keeps hashes only.
- **Origin check:**
  - The gateway checks each browser's `Origin` against its own address, then gives Next the one origin Next expects (Next builds request addresses from its configured host and port, and takes the scheme from `X-Forwarded-Proto`).
  - Behind the tunnel, cookies are `Secure` (`X-Forwarded-Proto` or Cloudflare's `Cf-Visitor`).
- **Local port, admin only on this computer:**
  - `/trial/owner` opens the owner's overview.
  - `/trial/lessons` adds lessons.
  - Never point a tunnel at it; `start-tunnel.mjs` refuses to.
- **No production credentials:**
  - The env file must be outside the repository and may hold only the classroom's vendor settings. Anything else is refused, including `POSTGRES_URL`, `AUTH_SECRET`, `CLASSROOM_TRIAL_CONSENT` and `LCIC_MIDCLASS_STOP_VERIFIED`.
  - Shell variables with such names are cleared.
  - Data goes to a new folder under `%LOCALAPPDATA%\iHear-classroom-trial\` (file store, no database server).
  - The session secret is made at start-up.
- **No recording in round 1:**
  - Consent cannot be set, so the server decides "not recorded" for every lesson.
  - LCIC rooms are created with `DisableRecord 1`.
  - The Zoom server never sends a recording start.
- **Closing:**
  - Ctrl+C on the tunnel ends outside access for everyone.
  - Ctrl+C on the server ends every link and session.
- **Logs:** they keep the method, path and status only, never a link's secret.

## Running a round-1 session

1. **Build:** `node scripts/prepare-public.mjs && npx next build`.
2. **Keys file**, outside the repository (for example `%LOCALAPPDATA%\iHear-classroom-trial\zoom.env`), holding `NAME=value` lines:
   - **Zoom:** `CLASSROOM_PROVIDER=zoom-video-sdk`, `ZOOM_VIDEO_SDK_KEY`, `ZOOM_VIDEO_SDK_SECRET`, `ZOOM_VIDEO_SDK_API_KEY`, `ZOOM_VIDEO_SDK_API_SECRET`, `ZOOM_VIDEO_SDK_WEBHOOK_SECRET`. No webhooks are used in round 1, so a random local value is enough for the webhook secret.
   - **LCIC:** `CLASSROOM_PROVIDER=tencent-lcic`, `LCIC_SDK_APP_ID`, `TENCENTCLOUD_SECRET_ID`, `TENCENTCLOUD_SECRET_KEY` (from a sub-user allowed only LCIC), `LCIC_CALLBACK_KEY` (random local value in round 1).
3. **Start the server:** `node tools/classroom-trial/trial-server.mjs --env <that file>`.
4. **Open the tunnel**, which needs approval: `node tools/classroom-trial/start-tunnel.mjs --allowed-mail <tester 1> --allowed-mail <tester 2>`.
5. **Add a lesson:** `node tools/classroom-trial/new-lesson.mjs --public <tunnel address> --date YYYY-MM-DD --time HH:MM` (Taipei). Send each link to its tester only.
6. **Follow the lesson** at `http://127.0.0.1:3311/trial/owner`, on this computer.
7. **Close:** Ctrl+C the tunnel, then the server. After the trial, revoke the keys at the vendor.

**Before round 1, at the vendor:**
- **Zoom:** automatic recording off; the participant recording options off; whiteboard on.
- **LCIC:** pay-as-you-go off.
