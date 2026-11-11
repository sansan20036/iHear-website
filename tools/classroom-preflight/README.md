# Classroom preflight tools

Checks to run before (and while) the classroom is opened in production. None of them changes
production, and none prints a secret. They read the Zoom keys from an env file kept outside the
repository and outside OneDrive (`zoom.env`), only inside the process.

| Tool | What it does | Sends |
|---|---|---|
| `env-check.mjs` | Compares Vercel's env listing (names, types, targets; never values) with the `closed`, `pilot` or `lessons` profile, and checks the owner's values file before anything is uploaded. `lessons` is the closed trial's real lessons with nothing recorded: the provider and the five Zoom values, and none of the consent or Drive settings (each one present fails as `RECORDS_OR_FILES`). Prints names and reason codes only. | nothing |
| `zoom-settings.mjs` | The Video SDK account's recording settings (`GET /accounts/me/settings`) against what the first pilot needs. Settings Zoom does not return are reported as unknown. | GET only |
| `zoom-sessions.mjs` | Live and past sessions, and each past session's recording files (types and sizes). Shortened ids; keys that are not ours are hidden. | GET only |
| `webhook-safe-check.mjs` | The live webhook: Zoom's URL validation, plus four requests that must be refused (no signature, wrong signature, another secret, stale timestamp). It signs nothing but `endpoint.url_validation`, so it is safe while the classroom is open: the route answers validation before any storage. | POST to the webhook only |
| `emergency-stop-live.mjs` | Finds the account's live sessions (one lesson's with `--lesson`) and hands them to `tools/classroom-recording-test/emergency-stop.mjs`: stop recording, end the session, confirm it is no longer live. Lists only, unless `--yes`. | GET; PATCH/PUT only with `--yes` |

```
node tools/classroom-preflight/env-check.mjs --profile closed --metadata <vercel-env.json>
node tools/classroom-preflight/env-check.mjs --profile pilot --values <pilot.env> --zoom-env <zoom.env>
node tools/classroom-preflight/env-check.mjs --profile lessons --metadata <vercel-env.json>
node tools/classroom-preflight/zoom-settings.mjs --env <zoom.env> [--json <out>]
node tools/classroom-preflight/zoom-sessions.mjs --env <zoom.env> [--days 7] [--recordings] [--json <out>]
node tools/classroom-preflight/webhook-safe-check.mjs --env <zoom.env> [--json <out>]
node tools/classroom-preflight/emergency-stop-live.mjs --env <zoom.env> [--lesson L-…] [--yes]
```

Tests: `npm run test:classroom:preflight` (synthetic: test-only keys, a local stand-in for Zoom,
and the site's own webhook route with its store replaced by a spy that records any use).
