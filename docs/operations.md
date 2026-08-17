# iHear production operations

This runbook covers uptime checks, Vercel server logs, encrypted offsite backups,
and restore drills. Never paste database URLs, OAuth secrets, or encryption passwords
into Git, issues, logs, or screenshots.

## 1. Uptime monitoring

The `Production uptime monitor` GitHub Actions workflow checks two HTTPS targets every
hourly from infrastructure outside Vercel and Supabase:

| Monitor | URL | Interval | Success condition |
| --- | --- | --- | --- |
| Application and database | `https://www.ihearus.org/api/health` | 1 hour | HTTP 200 and body contains `"status":"ok"` |
| Public homepage | `https://www.ihearus.org/` | 1 hour | HTTP 200 |

Recommended alert policy:

- Each workflow run retries three times before reporting a failure.
- A failure opens or updates a private GitHub issue named `Production uptime alert`.
- A successful later check comments on and closes the incident automatically.
- Do not attach response bodies from authenticated endpoints to alerts.
- The health endpoint is intentionally uncached and never returns database names,
  connection strings, SQL errors, or credentials.

Vercel Runtime Logs remain the first place to inspect a failed request. Use the
`X-Health-Request-Id` response header to correlate a health failure with logs.

## 2. Server-error investigation

Use Vercel Runtime Logs for server exceptions and function failures. Filter by the
Production environment and affected API path. The public health endpoint returns an
`X-Health-Request-Id` header that can be matched with the server log entry.

Do not log request cookies, authorization headers, OAuth state, database URLs, or
administrator email addresses. Availability alerts are handled by the external health
monitor rather than a paid application-error service.

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
- Review Vercel Runtime Logs for unresolved recurring server errors.
- Confirm at least one daily artifact, one weekly artifact, and the latest restore
  drill succeeded.
- Inspect artifact retention and GitHub Actions failures.
- Rotate database and monitoring credentials immediately after suspected exposure.

## 7. Sitewide content image deployment check

Before enabling administrator image replacement in Production:

1. Run `npm run db:migrate` and confirm Migrations 011 and 012 are tracked.
2. Run `npm run storage:configure-site-media` using the Production Supabase URL and
   service-role key. Never expose that key as a `NEXT_PUBLIC_` variable.
3. Confirm the `site-media` bucket is public-read, WebP-only, and limited to 1MB per
   object.
4. Confirm `/assets/vendor/browser-image-compression.js` returns HTTP 200 with a
   JavaScript content type in the Vercel Preview.
5. Upload a JPEG larger than 4.5MB through the admin dialog and confirm the browser
   sends a multipart request below 1.25MiB, then restore the repository default.

Application JSON and PostgreSQL backups preserve image metadata and immutable object
paths, not the Supabase Storage binary objects. Include the bucket in the separate
Supabase backup/recovery policy and test access to retained objects during reviews.

## Site theme release checks

After Migration 012 and the Production deploy, verify
`/api/site-theme/bootstrap` returns JavaScript with `Vercel-CDN-Cache-Control:
public, s-maxage=60, stale-while-revalidate=300`. Publish each allowlisted palette
as an administrator, then confirm an unsigned incognito window uses the same theme
across static pages, 404, and `/auth-error` without a warm-theme flash. The restore
drill must report four live revision scopes and a valid `site_theme` row.
