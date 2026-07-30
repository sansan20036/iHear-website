# iHear Website

Static iHear pages served by Next.js, with Auth.js / NextAuth.js Google sign-in.

## Local Preview

Install dependencies once:

```powershell
npm install
```

Run the Next.js dev server:

```powershell
npm run dev
```

Open:

```text
http://localhost:3000
```

The legacy static server is still available if needed:

```powershell
npm run serve:legacy
```

It prepares and serves the same sanitized `public/` output as Next.js, so local
preview never loads the production-only Cloudflare analytics beacon.

## Quality checks

Run the JavaScript linter:

```powershell
npm run lint
```

Run the automated browser regression tests:

```powershell
npm test
```

This runs Vitest coverage for the API authorization, cache headers, validation,
create/update/delete, and conflict responses, followed by Playwright browser tests.

The first test run on a new computer may require the Playwright browser:

```powershell
npx playwright install chromium
```

Run lint, TypeScript, browser tests, and the production build together:

```powershell
npm run check
```

Browser-test artifacts are written below the gitignored `output/playwright/` directory.

## Google Sign-In

Auth.js reads these environment variables:

```text
AUTH_SECRET=
AUTH_GOOGLE_ID=
AUTH_GOOGLE_SECRET=
```

`AUTH_SECRET` is required locally and in production. Use a random 32+ character value.

Create Google OAuth credentials and add these redirect URIs:

```text
https://www.ihearus.org/api/auth/callback/google
https://ihearus.org/api/auth/callback/google
http://localhost:3000/api/auth/callback/google
```

The front end checks login state through:

```text
/api/auth/session
```

When signed in, the session exposes basic Google profile fields:

```text
session.user.name
session.user.email
session.user.image
session.user.isAdmin
```

The nav login widget also exposes:

```text
window.iHearAuth.getSession()
window.iHearAuth.isSignedIn()
```

There is no domain allowlist in `auth.js`, so any Google account can sign in once the OAuth consent screen and credentials are configured.

## Inline Editing

Logged-in admins can edit simple text directly on the page. The current admin fallback list is:

```text
sansan20036@gmail.com
shuchen.peng@gmail.com
ihearprogram@gmail.com
```

You can override this later with:

```text
AUTH_ADMIN_EMAILS=sansan20036@gmail.com,shuchen.peng@gmail.com,ihearprogram@gmail.com
```

Auth.js calculates `session.user.isAdmin` from this server-side list. Browser editing
controls consume that boolean instead of duplicating admin email addresses in client code;
all write APIs still repeat the authorization check on the server.

With `POSTGRES_URL` or `DATABASE_URL` configured, text overrides are read from and
written to the `content_overrides` Postgres table. Its schema is in:

```text
db/migrations/004_content_overrides.sql
```

The table has a composite `(page, key)` primary key, audit metadata, validation
constraints, and Row Level Security enabled without public policies. The application
uses the server-side Postgres connection, so browser clients never receive database
credentials. In local development only, when no database URL is configured, the same
API falls back to `content.json`.

The browser loads saved text from:

```text
/api/content/get
```

Public content reads use a 24-hour tagged server data cache plus a one-second Vercel
edge cache. Successful admin updates immediately expire the data tag and revalidate
both the edited page and the public content API.

Saving posts JSON to:

```text
/api/content/update
```

The update API checks the Auth.js session again on the server before writing. Hosted
production refuses to use the filesystem fallback, preventing a serverless deployment
from reporting a successful but non-durable save.

Create the table and safely insert any missing `content.json` overrides. Existing
database rows win on conflicts, so rerunning this command will not overwrite newer
inline edits:

```powershell
npm run db:migrate-content
```

Verify the table, row count, and RLS status:

```powershell
npm run db:check-content
```

## Database migrations and backups

Apply all pending SQL files from `db/migrations` and record their SHA-256 checksums
in the server-only `public.schema_migrations` table:

```powershell
npm run db:migrate
```

The command is safe to rerun. Applied migrations are skipped, and changing an
already-recorded migration file is rejected. Add a new numbered migration instead.

Run the repeatable database health audit:

```powershell
npm run db:audit
```

It exits with an error when a required table or constraint is missing, migration
checksums differ, RLS is disabled, or stored data violates the application rules.

Create a local baseline backup:

```powershell
npm run db:backup
```

Backups are written beneath the gitignored `backups/` directory. They contain the
three application-data tables, migration history, constraints, indexes, and a
SHA-256 checksum, but never contain the database connection URL or API keys.

Verify the newest backup and simulate restoring it inside a transaction:

```powershell
npm run db:verify-backup
```

The restore simulation is always rolled back and confirms the live database is
unchanged. Pass a backup path after `--` to verify a specific snapshot.

## Impact milestone management

The complete About-page journey timeline is data-driven. Each record is either a
translated journey event (date, title, and description) or an impact-metrics item.
Public visitors read published records from:

```text
GET /api/impact-milestones
```

Published records use a 24-hour tagged server data cache plus a one-second Vercel
edge cache. Every successful create, update, or delete immediately expires the data
tag and revalidates `/about` and the public milestone API. Draft reads remain private
and use `no-store`.

Allowed admins can use the management controls on `/about` to edit every timeline
date, title, description, and metric, and to add, save as draft, publish, or permanently
delete records. Deletion is version-checked, requires confirmation in the UI, and cannot
be undone. The editor includes Traditional Chinese, Simplified Chinese, and English tabs
with completion indicators and a live preview. The editor currently uses manual translation
mode: admins enter or paste each language themselves, or copy another language into the
active tab as a starting point before revising it. Drafts may contain incomplete languages,
while publishing requires all three descriptions and, for journey events, all three titles.
Admin APIs use:

```text
POST   /api/impact-milestones
PATCH  /api/impact-milestones/:id
DELETE /api/impact-milestones/:id
```

The server-side automatic translation route remains available for future evaluation, but
the current browser editor does not call it. Manual multilingual editing therefore does not
depend on an OpenAI key or any external translation service.

Set either `POSTGRES_URL` or `DATABASE_URL` in hosted production. The schema is in
`db/migrations/001_impact_milestones.sql` with the journey upgrade in
`db/migrations/002_journey_timeline_items.sql` and the permanent-delete seed marker in
`db/migrations/003_permanent_delete_seed_marker.sql`; the application also creates the table
and seeds the nine initial timeline records only on first initialization. This prevents
permanently deleted seed records from returning after a restart. In local development,
when no Postgres URL is present, edits are written to the ignored
`data/impact-milestones.json` file.

Published reads use a versioned journey-timeline Next.js data-cache tag. Successful admin
mutations expire the tag and revalidate `/about`. The static About HTML remains CDN
cacheable while its milestone data is refreshed independently.

## Vercel

Use these settings:

- Framework Preset: `Next.js`
- Build Command: `npm run build`
- Output Directory: leave blank
- Install Command: `npm install`

Add the same Auth.js environment variables in Vercel Project Settings.

Clean URLs such as `/team` are mapped by `next.config.mjs`.

## Phase 2 maintenance backlog

The production launch is not blocked by these items. Schedule them after the site
has accumulated enough real usage to justify the additional operational complexity:

- Add an authenticated non-admin regression test for every admin write endpoint.
- Add application-level rate limiting for authentication and admin mutation APIs.
- Connect uptime and server-error monitoring with an agreed alert recipient.
- On the Supabase Free plan, create an off-site database export at least weekly and
  run `npm run db:verify-backup` as a documented restore drill. Revisit managed daily
  backups or point-in-time recovery if the project moves to a paid plan.
