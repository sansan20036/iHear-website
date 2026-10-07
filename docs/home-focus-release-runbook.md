# Home focus release and recovery runbook — CP6

This runbook prepares a later, separately authorized release. **No production connection, backup, migration, Git push or deployment was performed during CP6.** The candidate identity, final check results and local evidence are recorded in [the CP6 report](home-focus-checkpoint-6.md) and `output/cp6-home-focus/candidate.json`.

These instructions supersede the deployment paragraph and generic pre-gallery code-rollback advice in `docs/media-galleries.md` for this release. The former positional invocation of `verify-gallery-deployment.mjs` is intentionally rejected with a migration message: the old application JSON backup is not a complete release baseline or recovery backup. In particular, `scripts/backup-database.mjs` omits `resource_topics` and `site_content_revisions`. Do not use it or its rollback-only restore simulation as evidence of committed migration recovery.

## Confirmed release architecture and gates

| Repository evidence | Actual behavior |
| --- | --- |
| `package.json`, `.github/workflows/ci.yml` | Node 24; CI pins Node 24.11.1 / npm 11.6.2, installs optional packages and Chromium, then runs `npm run check`. CI triggers on PR, `main` push and manual dispatch. It does not run database migration or publish the application. |
| `vercel.json` | Next.js; `npm ci --include=optional`, then `npm run build`. This configured install command takes precedence over README's older `npm install` advice. Build prepares source HTML/assets before `next build`. |
| Vercel project configuration | The linked Git project, Production Branch, automatic deployment settings, credentials and current deployed commit are **not established by repository files**. Verify them in the real project before any push. A `main` CI trigger does not prove the Vercel Production Branch. |
| `netlify.toml` | Legacy static routing only; it is not an approved delivery path for the request-time Next.js Banner/API release. |
| `scripts/migrate-database.mjs` | `npm run db:migrate` is the actual runner. It takes an advisory lock, verifies names/checksums of applied migrations, and commits each pending SQL file together with its ledger insertion. CP1 and CP6 use this runner for 023 → 024. |
| `lib/media-gallery-store.ts` | A non-Vercel PostgreSQL store initialization can execute 019/024 DDL and seed without creating the runner's ledger entries. On hosted production (`NODE_ENV=production` and `VERCEL`), that local DDL branch is disabled, but other read/initialization paths can still seed missing rows. A GET or starting an app is not a database read-only preflight. |

Release gates: final candidate verification and checks must pass; the real DB must pass the appropriate phase check; a usable native backup and independent restore must exist; writers must stay frozen through the preservation comparison; the real Vercel project/branch and recovery destination must be identified. Stop on any mismatch. Do not fix a ledger, slug, published status or Banner data merely to make a check pass.

## 1. Verify the frozen candidate

Run from the same candidate worktree in PowerShell:

```powershell
git rev-parse HEAD
git status --short
node scripts/home-focus-candidate.mjs verify output/cp6-home-focus/candidate.json
if ($LASTEXITCODE -ne 0) { throw 'Candidate bytes or preservation baseline changed' }
```

The manifest covers source, configuration, lockfile, all 24 migrations, required scripts, tests and documentation; it excludes dependencies, generated output, credentials and evidence. Its code ID excludes documentation to avoid a report/identifier cycle; its delivery digest includes documentation. It is a **worktree byte manifest**, not a claim that the old HEAD contains these changes. All required new files must be included in the later reviewed commit. Archive the ignored acceptance evidence separately.

Do not regenerate a baseline to hide a mismatch. Investigate it, rerun affected checks and deliberately freeze a new candidate if a real change is necessary. A new checkout can change line endings with Git `core.autocrlf`; the manifest also records Git clean-filtered blob IDs. Use `verify-commit` below to compare the exact committed tree and record the new commit/CI evidence rather than falsely claiming a Windows raw-byte manifest is portable across OS checkouts. Never edit historical SQL to fix that difference.

Before the later release, the operator reviews the candidate file list and stages the intended files, including the untracked CP0–CP6 source. Record `git diff --cached --stat` and `git diff --cached --check`; commit only after the user's release authorization. Do not use a blanket `git add .` to include unrelated future work. After the authorized commit, run `node scripts/home-focus-candidate.mjs verify-commit output/cp6-home-focus/candidate.json HEAD` and require exit 0 before pushing. This verifies the exact committed paths and blob content, including new files and documentation. It rejects symlink/submodule entries but does not distinguish executable from non-executable regular-file mode; the current repository has no executable-mode files and uses Node/npm entry points.

## 2. Production preflight: direct SQL only

Use an explicitly injected, narrowly scoped connection in `CP6_READONLY_DATABASE_URL`. The verifier never reads `.env`, never falls back to another URL, imports no store, and makes no API calls. It sets connection-level `default_transaction_read_only=on` and executes a repeatable-read read-only transaction with a 15-second statement timeout. It disables RLS filtering for the transaction so a role unable to see all rows fails instead of producing a misleading partial snapshot. Use an audited read account able to inspect every required table and catalog; do not print its secret.

Prepare a private release directory outside the deliverable. Snapshots contain application records and internal metadata; keep access restricted and encrypt/archive them with the dump. The verifier writes new files exclusively and will not overwrite a baseline.

```powershell
$releaseDir = Join-Path (Get-Location) ('backups/cp6-release-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $releaseDir -ErrorAction Stop | Out-Null
if (-not $env:CP6_READONLY_DATABASE_URL) { throw 'Inject the approved read-only connection first' }
if ($env:POSTGRES_SSL -eq 'disable') { throw 'Remove the insecure local-only Node PG override before production checks' }
$env:POSTGRES_SSL = 'require'
# Also inject the provider-approved libpq PGSSLMODE / certificate settings before
# native commands. Node's POSTGRES_SSL and libpq TLS settings are independent.
node scripts/verify-gallery-deployment.mjs --phase pre-024 --database-env CP6_READONLY_DATABASE_URL --snapshot-output "$releaseDir/pre-024.json"
if ($LASTEXITCODE -ne 0) { throw 'Stop: production is not the reviewed 001–023 baseline' }
```

Expected: `verified:true`, `transaction_read_only:on`, `transaction_isolation:repeatable read`, 23 correctly named/checksummed ledger rows, original five named galleries, the old five-ID CHECK, unchanged version/items/PK constraints, RLS, resource relationship/slug uniqueness and guard. The report identifies actual `announcements → announcements` and `calendar → calendar` mappings from 023's reserved seeds. Draft/archived topics or zero published items are valid empty homepage results, not schema faults. Missing/misassigned topics, duplicates or altered constraints are blockers; no automatic publication/renaming/seeding occurs.

If production has already applied 024, do not falsify a pre-024 baseline. Inspect that result, then run `--phase post-024` into a new file; it must show 24 matching ledger rows, the expanded CHECK and a `home-banner` row. An empty Banner is valid. Use that accepted post-024 snapshot as the same-phase baseline for this release and its backup/restore checks. Do not rerun a raw SQL file or delete its migration record. Other intermediate/unknown histories require review before proceeding.

The tool snapshots **every existing public table**, including old galleries/items/video/order, assets, operations, resources, translations, migration rows and revisions. PostgreSQL's exact JSON text preserves array order and bigint digits beyond JavaScript's safe integer range. It also records actual constraints, enabled triggers and RLS. The static reservation check reads the candidate allocator's declared reserved set; behavioral allocation is separately covered by the model tests. It does not change stored names, IDs, slugs or status.

## 3. Freeze writes, back up, and prove the backup is usable

There is **no repository maintenance-mode flag**. The release operator must obtain confirmation from all administrators to stop edits/uploads, pause scheduled jobs/imports/other SQL writers, and arrange platform traffic gating before the backup. Public traffic can write rate-limit or initialization records; for an exact all-public-table comparison, that traffic must also be quiescent. Record the freeze start, responsible operator, paused writers and traffic-gating mechanism. Platform access/gating configuration is a deployment prerequisite, not something this runbook assumes already exists. If the operator cannot establish it, stop the release.

Take a fresh verifier snapshot **after** the freeze, then the dump. Compare again immediately after the dump and before migration. This establishes the recoverable data time point and catches a writer missed by the freeze; it does not make future uncoordinated writes safe. No writer may resume until all release checks are accepted. If any unexpected row/revision difference appears, preserve both snapshots, stop, reconcile the writes and take a new backup under a verified freeze. Do not subtract those differences or restore over them.

Native PostgreSQL 17 tools must be available and compatible with the actual server major version. Check `pg_dump --version`, `pg_restore --version`, and the verifier's reported server version. CP6 rehearses PostgreSQL 17. The commands below use standard libpq environment (`PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSFILE` and approved TLS parameters) injected securely for the **same source** as the read-only URL. Record the intended server/database identity privately; do not print passwords or a full URL. Stop if the two targets differ.

```powershell
node scripts/verify-gallery-deployment.mjs --phase pre-024 --database-env CP6_READONLY_DATABASE_URL --snapshot-output "$releaseDir/frozen-pre-024.json"
if ($LASTEXITCODE -ne 0) { throw 'Frozen baseline failed' }
pg_dump --format=custom --schema=public --no-owner --no-acl --file="$releaseDir/pre-024.dump"
if ($LASTEXITCODE -ne 0) { throw 'Native backup failed' }
pg_restore --list "$releaseDir/pre-024.dump" | Set-Content -LiteralPath "$releaseDir/restore-list.txt"
if ($LASTEXITCODE -ne 0) { throw 'Backup archive cannot be read' }
Get-FileHash -Algorithm SHA256 -LiteralPath "$releaseDir/pre-024.dump" | Format-List
node scripts/verify-gallery-deployment.mjs --phase pre-024 --database-env CP6_READONLY_DATABASE_URL --baseline "$releaseDir/frozen-pre-024.json" --snapshot-output "$releaseDir/after-backup-pre-024.json"
if ($LASTEXITCODE -ne 0) { throw 'Writes occurred after the frozen baseline; stop' }
```

No table data is excluded from this release dump (unlike the scheduled weekly job's rate-limit exclusion). This custom archive contains public-schema DDL/data, not managed `auth`/`storage` schemas, cluster roles, ownership/ACL restoration or external image bytes. Preserve provider-managed recovery/PITR, grants/role configuration and object-storage backups separately; retained asset paths require their corresponding immutable objects. A list/checksum alone is insufficient: restore the dump to a newly provisioned isolated destination using section 7, then compare its pre-024 snapshot to `frozen-pre-024.json`. Keep the production source untouched. Securely encrypt and retain the verified archive offsite before migration; key custody and storage provider configuration remain release-operator responsibilities.

For a database already at 024, substitute `post-024` in the verifier phases/filenames above and below. The native dump commands and unchanged-data comparison remain the same.

## 4. Apply the tracked migration before any new application startup

Only after backup validation, inject the approved writer URL in `CP6_RELEASE_DATABASE_URL`. Set **both** runner variables to the same target; the existing runner itself loads environment configuration, so do not leave a stale URL with higher precedence. Run from the frozen repository root, not a temporary folder with a different migration set.

```powershell
if (-not $env:CP6_RELEASE_DATABASE_URL) { throw 'Inject the approved migration connection first' }
$env:POSTGRES_URL = $env:CP6_RELEASE_DATABASE_URL
$env:DATABASE_URL = $env:CP6_RELEASE_DATABASE_URL
npm run db:migrate
if ($LASTEXITCODE -ne 0) { throw 'Migration failed; retain freeze and inspect runner output' }
node scripts/verify-gallery-deployment.mjs --phase post-024 --database-env CP6_READONLY_DATABASE_URL --baseline "$releaseDir/frozen-pre-024.json" --snapshot-output "$releaseDir/committed-post-024.json"
if ($LASTEXITCODE -ne 0) { throw 'Post-migration preservation mismatch; do not deploy' }
Remove-Item Env:POSTGRES_URL, Env:DATABASE_URL
```

Expected runner output: applied only `024_home_banner_gallery.sql`; 001–023 skipped with matching checksums. The baseline comparison allows exactly: the expanded ID CHECK; one 024 ledger row; the initial `home-banner` photo row when previously absent; and the content revision's single statement-trigger increment/timestamp. Other data and schema remain identical. For an already-024 database, the runner should skip all 24; compare against the accepted frozen **post-024** baseline instead, allowing no differences. Empty Banner remains empty and is never reseeded by verification or runner rerun.

Do not use a local `npm start`, page GET, `db:audit` with unreviewed scope, or store initialization to upgrade/repair the production database. The explicitly tracked runner is the release entry. A failed migration's SQL and ledger insert roll back together; previously committed migration files remain committed. CP1 proves that pre-commit boundary; section 7 covers recovery after commit.

## 5. Publish the exact reviewed application

While the freeze remains in effect, verify the actual Vercel project is configured for the intended repository, Next.js, the install/build commands above, Node 24, and the intended Production Branch. Check production database/storage/auth configuration without copying secrets into evidence. Ensure the new revision cannot start against a pre-024 database. Record the previous deployment ID/commit for investigation; it is **not a validated rollback target**.

Before pushing to the Production Branch, require the existing full CI workflow to have passed for this exact release commit through an approved non-production branch/PR or manual dispatch. Confirm those paths cannot themselves publish to production. The repository does not prove that Vercel waits for CI; a Git-triggered deployment may start immediately after a production push. Only after this CI gate, separately authorized commit/push, project/branch confirmation and section 4 success:

```powershell
git rev-parse HEAD
git status --short
git diff --check
# Set this only to the Production Branch confirmed in the real Vercel project.
$releaseBranch = 'main'
git push origin "HEAD:$releaseBranch"
if ($LASTEXITCODE -ne 0) { throw 'Push failed; inspect before retrying' }
```

`main` above is valid only if the platform check confirms it. If it differs, use the confirmed branch and retain the successful full CI evidence for the exact release commit; do not waive CI or assume that a later `main` push check gates deployment. In the linked Vercel project, observe the Git-triggered deployment and record commit, build result, deployment ID and production-domain assignment. If the project is not Git-linked or auto-deployment is disabled, stop to define/authorize its actual publishing mechanism; do not substitute an unconfigured CLI or assume the CI workflow deploys. No command in this repository automatically makes `npm run db:migrate` part of Vercel build.

A build failure or wrong commit prevents production promotion and keeps the freeze. Do not silently rebuild from another worktree or directly patch generated `public/` / `.private/`. If code changes are necessary, make a new candidate and rerun affected gates.

## 6. Verify live application, cache and CSP before reopening writes

These are **post-deployment checks**, not pre-migration read-only preflight. API GETs may initialize application data. Use the verified production origin (current repository browser configuration targets `https://www.ihearus.org`) and anonymous requests. Save headers/body in the private evidence directory:

```powershell
$releaseOrigin = 'https://www.ihearus.org'
if ($releaseOrigin.TrimEnd('/') -ne 'https://www.ihearus.org') { throw 'Production browser config and read-only guard target a different origin; stop and review them before testing' }
curl.exe --fail --silent --show-error --max-time 15 --dump-header "$releaseDir/home.headers" --output "$releaseDir/home.html" "$releaseOrigin/"
if ($LASTEXITCODE -ne 0) { throw 'Homepage request failed' }
curl.exe --fail --silent --show-error --max-time 15 --dump-header "$releaseDir/banner.headers" --output "$releaseDir/banner.json" "$releaseOrigin/api/media-galleries?gallery_id=home-banner"
if ($LASTEXITCODE -ne 0) { throw 'Public Banner API failed' }
curl.exe --fail --silent --show-error --max-time 15 --dump-header "$releaseDir/resources.headers" --output "$releaseDir/resources.json" "$releaseOrigin/api/resources"
if ($LASTEXITCODE -ne 0) { throw 'Resources failed, including unavailable Guides takeover' }
curl.exe --fail --silent --show-error --max-time 15 --dump-header "$releaseDir/revisions.headers" --output "$releaseDir/revisions.json" "$releaseOrigin/api/live-revisions"
if ($LASTEXITCODE -ne 0) { throw 'Live revision API failed' }
Get-Content "$releaseDir/home.headers", "$releaseDir/banner.headers", "$releaseDir/resources.headers", "$releaseDir/revisions.headers"
npm run test:production
if ($LASTEXITCODE -ne 0) { throw 'Production public browser regression failed' }
```

Check response bodies and the real browser: first Banner and its SSR JSON agree with the public filtered snapshot; hidden items/operation metadata are absent; a genuinely empty Banner collapses its position; announcements/calendar use the current complete Resources snapshot (`items`, `topics`, valid `guidesTakeover`); empty/unpublished categories remain empty; three languages, manual controls/retry and no-JavaScript entries work. Visit `/resources#announcements`, `/resources#calendar`, `/resources#resource-links` and `/resources#resource-guides` using the actual homepage links. Missing unpublished categories correctly lead to the basic Resources entry; do not publish content to make a test fixture appear. Existing gallery video and representative Resources actions must work. Production browser tests prohibit mutations and external navigation; record any separately inspected form destination without submitting it.

| Response | Required cache behavior |
| --- | --- |
| Homepage and public galleries JSON | Application `Cache-Control: private, no-store, max-age=0`; configured Vercel CDN `no-store`. |
| Resources JSON | `Cache-Control: no-store`; configured Vercel CDN `no-store`. Do not require the gallery's exact Cache-Control string. |
| `/api/live-revisions` | Existing browser revalidation and Vercel CDN TTL 3 seconds; do not replace it with no-store or a new polling policy. |
| Valid versioned image URL returned by the actual public media payload | One-year `max-age=31536000, immutable` (CDN one-year policy). Use the returned URL/version; an invented/stale version or unversioned static fallback is not this test. |

For the image, copy a real versioned URL from the accepted public payload into `$releaseImageUrl` and execute `curl.exe --fail --silent --show-error --max-time 15 --dump-header "$releaseDir/image.headers" --output "$releaseDir/image.bin" "$releaseImageUrl"`. If no versioned custom image exists, record that live check as unavailable and retain the isolated fixture evidence; do not upload a production image solely for the test.

Vercel may consume its CDN-control header before forwarding a response. Absence of that header at the client alone neither proves a violation nor proves correct caching. Record repeated response headers (`Age`, `X-Vercel-Cache` when supplied), effective platform cache configuration and actual newly authored content behavior during the separately authorized release validation. Browser no-store and public JSON contents must still be correct. A stale or hidden-content leak is a stop condition. Local Next responses and configuration checks are evidence of source behavior only, not effective production CDN delivery.

Record the **actual** `Content-Security-Policy` and `Content-Security-Policy-Report-Only` response headers. `vercel.json` declares an enforcing policy; local `next start` does not automatically add this platform header. Enforcing CSP requires a live browser check for blocked scripts/images/requests and a working first screen, controls, cards and links. Report-Only is monitoring, not enforcement proof. An absent enforcement header or only Report-Only must be marked as such and investigated against the configured production policy, not reported as CSP passed. Do not loosen the policy to hide a failing feature. Preserve console/network evidence and platform policy headers.

After these checks, record release acceptance, reopen traffic/writers in the reverse order used for the freeze, and record that time. Compare any intended post-release admin action through its actual public read path. Do not run the strict frozen-baseline comparator after legitimate post-release writes and interpret their presence as corruption.

## 7. Recovery after migration commit

The tested recovery is **native backup restoration into a different database**. It does not narrow the gallery CHECK, remove a migration ledger row, delete Banner data or issue a down migration. No exact previous application version was tested against the upgraded DB; therefore “old code + upgraded DB” is not an available validated rollback path. Database restoration alone also does not qualify an old app for release.

Keep traffic/writers frozen. Retain the failed source and take an additional forensic backup without overwriting the verified pre-release archive. Provision a **new, empty, explicitly named isolated destination**, with the same PostgreSQL major version and required extensions. Use a separate approved destination connection/role configuration; validate that its server/database identity is not the source. For provider-managed PostgreSQL, provision the appropriate managed project/branch through its approved procedure and preserve/reapply reviewed role/grant configuration separately. Do not run `--clean` against production.

With libpq environment changed to that isolated destination and `CP6_RESTORE_READONLY_DATABASE_URL` pointing to the same destination:

```powershell
# The destination must already exist and be empty; pg_restore does not choose it for you.
if (-not $env:PGDATABASE -or -not $env:CP6_RESTORE_READONLY_DATABASE_URL) { throw 'Explicit restore destination required' }
psql -X --set=ON_ERROR_STOP=1 --command="SELECT current_database(), inet_server_addr(), inet_server_port();"
if ($LASTEXITCODE -ne 0) { throw 'Cannot identify restore destination' }
# Verify that identity is the newly provisioned destination, never the source.
# --schema=public archives include CREATE SCHEMA public. Remove only the empty
# destination's default schema; omission of CASCADE makes existing objects a blocker.
psql -X --set=ON_ERROR_STOP=1 --command="DROP SCHEMA public;"
if ($LASTEXITCODE -ne 0) { throw 'Destination public schema is not empty/available; stop, do not add CASCADE' }
pg_restore --exit-on-error --single-transaction --no-owner --no-acl --dbname="$env:PGDATABASE" "$releaseDir/pre-024.dump"
if ($LASTEXITCODE -ne 0) { throw 'Restore failed; do not redirect application traffic' }
node scripts/verify-gallery-deployment.mjs --phase pre-024 --database-env CP6_RESTORE_READONLY_DATABASE_URL --baseline "$releaseDir/frozen-pre-024.json" --snapshot-output "$releaseDir/restored-pre-024.json"
if ($LASTEXITCODE -ne 0) { throw 'Restored data/schema differs from backup time' }
```

Expected: zero data differences, original five-gallery CHECK, original revisions and 001–023 migration ledger, all old images/items/videos/order/operations retained. PostgreSQL's official `pg_get_constraintdef(oid,true)` output is compared for semantic formatting stability; raw definitions remain in snapshots. Native dump/restore can flatten redundant AND grouping introduced by `BETWEEN`. The tool does not blindly strip parentheses or ignore AND/OR differences. Restore of an accepted post-024 backup uses post-024 baseline/phase and preserves an empty Banner unchanged.

This returns data to the frozen snapshot/backup time, **not** to the later release failure time. If the write freeze was maintained, no intended intervening admin edits are lost. If writers resumed or escaped the freeze, keep both databases, identify and reconcile all newer writes/objects before any switch. Do not overwrite them automatically. External media objects referenced by restored rows must remain available; do not delete newer immutable objects during recovery.

Restore completion is a data-recovery checkpoint. Before changing production DB connection settings or routing traffic, verify the intended application against the recovered database in isolation. CP6's current application requires migration 024: a pre-024 restored DB must remain offline until a reviewed application/forward-repair plan is chosen and validated. The runbook does not claim instant service rollback to an unspecified old binary. The operator records the approved application commit, any newly executed forward migration, destination/grants/storage verification and repeated section 6 checks before reopening. If an immediate old-version rollback is a release requirement, it remains a gate until that exact version is separately tested; do not substitute the historical pre-gallery recommendation.

## Local proof and remaining production checks

Run `npm run test:home-focus-recovery` only for the disposable Docker PostgreSQL 17 rehearsal. It uses a uniquely named loopback-only container, applies the actual runner through 023, writes representative records, produces a public custom dump, commits 024, restores to a second database and compares complete data/schema/revisions/ledger. It invokes the deployment verifier before/after/after restore and proves those checks do not mutate state. The administrator-cleared post-024 Banner no-reseed guarantee retains CP1's earlier evidence; it is not one of this rehearsal's 43 checks. Only its own container is cleaned up. Commands, versions, dump hash, raw/normalized constraints and comparison evidence are under `output/cp6-home-focus/recovery/<run-id>/`; the final run is linked by the CP6 report.

The completed rehearsal is [run 3c2ec64c-f933-43e9-8846-a8890b39e6d2](../output/cp6-home-focus/recovery/3c2ec64c-f933-43e9-8846-a8890b39e6d2/report.json): **43 passed, 0 failed, 0 skipped, exit 0**, PostgreSQL/pg_dump/pg_restore 17.11 on Docker Desktop, Windows host. Its [restore comparison](../output/cp6-home-focus/recovery/3c2ec64c-f933-43e9-8846-a8890b39e6d2/restore-diff.json) shows all 21 public tables plus columns/defaults, constraints, indexes, RLS, triggers, functions, policies and sequences restored. Before/after data+schema digest: `7b3487222c1c05c4237644ac7f0e3d477eb02b277113e20767d3fb5de57d9b14`; archive SHA-256: `94b7570df9199c1cd4cfbfec59d94d0af40a8d7345011cfd27e67d0c5d875dcd`. The [commands](../output/cp6-home-focus/recovery/3c2ec64c-f933-43e9-8846-a8890b39e6d2/commands.json) preserve actual arguments and exit codes with database secrets redacted. Earlier attempts remain as diagnostic evidence: raw CHECK parentheses after restore and the existing empty `public` schema exposed and motivated the narrowly scoped fixes above. They are not counted as successful runs.

The 22-case deployment-verifier unit suite is `npx --no-install vitest run tests/gallery-deployment-verifier.test.mjs` and is included in Operations. Local proof does not establish the production database's ledger/ID mapping, managed role/storage configuration, deployment branch, provider traffic controls or effective CDN/CSP. Those remain explicit execution-time checks above. BFCache, screen-reader and other-engine evidence must be described exactly as measured in the CP6 report; this runbook grants no new exemption from existing browser support requirements.
