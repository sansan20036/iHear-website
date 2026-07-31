# iHear production operations

This runbook covers uptime checks, server-error reporting, encrypted offsite backups,
and restore drills. Never paste database URLs, OAuth secrets, Sentry tokens, or
encryption passwords into Git, issues, logs, or screenshots.

## 1. Uptime monitoring

Create two HTTPS monitors in Better Stack, UptimeRobot, or an equivalent service:

| Monitor | URL | Interval | Success condition |
| --- | --- | --- | --- |
| Application and database | `https://www.ihearus.org/api/health` | 1 minute | HTTP 200 and body contains `"status":"ok"` |
| Public homepage | `https://www.ihearus.org/` | 5 minutes | HTTP 200 |

Recommended alert policy:

- Confirm the failure from at least two locations or two consecutive checks before paging.
- Notify at least two maintainers by email; add SMS/phone only for repeated failures.
- Do not attach response bodies from authenticated endpoints to alerts.
- The health endpoint is intentionally uncached and never returns database names,
  connection strings, SQL errors, or credentials.

Vercel Runtime Logs remain the first place to inspect a failed request. Use the
`X-Health-Request-Id` response header to correlate a health failure with logs.

## 2. Server-error monitoring with Sentry

Create a Sentry project for Next.js, then add these variables to the Vercel project:

| Variable | Environments | Purpose |
| --- | --- | --- |
| `SENTRY_DSN` | Production, Preview as desired | Sends server exceptions |
| `SENTRY_ORG` | Build environments | Source-map project owner |
| `SENTRY_PROJECT` | Build environments | Source-map target project |
| `SENTRY_AUTH_TOKEN` | Build environments only | Uploads source maps |
| `SENTRY_TRACES_SAMPLE_RATE` | Optional | Defaults to `0.05` |

The site still builds and runs when all Sentry variables are absent. Error events are
scrubbed before sending: email, username, IP address, cookies, authorization headers,
and query strings are removed. Do not enable Sentry's default PII collection.

Suggested alerts:

- New server issue in Production.
- More than five server errors in five minutes.
- `/api/health` reports HTTP 503 twice in succession.

## 3. GitHub backup secrets

Add the following repository Actions secrets under **Settings > Secrets and
variables > Actions**:

| Secret | Required | Notes |
| --- | --- | --- |
| `BACKUP_DATABASE_URL` | Yes | Supabase Session pooler URI, normally port 5432; do not use transaction pooler port 6543 for `pg_dump` |
| `BACKUP_ENCRYPTION_PASSWORD` | Yes | Random 32+ character password stored in a separate password manager |
| `BACKUP_HEARTBEAT_URL` | No | Success heartbeat for daily and weekly backups |
| `RESTORE_HEARTBEAT_URL` | No | Success heartbeat for monthly restore drills |

Use the connection URI produced by Supabase. If a password is inserted manually,
percent-encode URL-reserved characters. The backup database account needs read access
to the public schema; it must not be a browser-visible key.

If `BACKUP_ENCRYPTION_PASSWORD` is lost, encrypted artifacts cannot be restored. If it
is exposed, rotate it and create a new backup immediately; old artifacts remain tied
to the old password until they expire.

## 4. Automated schedule and retention

- Daily at 01:30 Asia/Taipei: application JSON backup, integrity verification,
  AES-256-CBC encryption, GitHub artifact retention for 35 days.
- Monday at 02:15 Asia/Taipei: PostgreSQL custom-format logical dump, encrypted and
  retained for 92 days.
- Monthly on day 2 at 02:45 Asia/Taipei: a fresh Production dump is encrypted,
  decrypted, and restored into a temporary PostgreSQL service. Production is only
  read by `pg_dump`; all restore writes happen in the isolated service.

GitHub scheduled workflows use UTC and can start later during platform load. Run all
three workflows manually after configuring secrets; a schedule is not considered
active until its first successful run is reviewed.

GitHub artifacts are off the Vercel/Supabase infrastructure, but remain inside the
GitHub trust boundary. If the data set becomes business-critical, copy encrypted
artifacts to a second provider such as an access-restricted S3/R2 bucket.

## 5. Manual artifact verification

Download an artifact and verify it before decrypting:

```bash
sha256sum -c SHA256SUMS
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
  -in ihear-postgres-YYYYMMDDTHHMMSSZ.dump.enc \
  -out ihear-postgres.dump \
  -pass env:BACKUP_ENCRYPTION_PASSWORD
pg_restore --list ihear-postgres.dump
```

Do not restore directly into Production as a test. Restore into a new, isolated
database first, validate migrations and row counts, then use a separately reviewed
maintenance plan if a real Production recovery is required.

## 6. Monthly review

- Confirm the two uptime monitors are green and alert recipients are current.
- Confirm Sentry has no unresolved recurring server errors.
- Confirm at least one daily artifact, one weekly artifact, and the latest restore
  drill succeeded.
- Inspect artifact retention and GitHub Actions failures.
- Rotate database and monitoring credentials immediately after suspected exposure.
