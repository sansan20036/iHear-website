# Home focus release and recovery runbook — CP7 integration candidate

This revision prepares the integrated Academy + CP0–CP6 candidate for a later authorized release. **This CP7 integration round permits local integration and platform read-only checks only: no push, Preview, deployment, platform mutation, formal freeze/backup/migration or production application request.** The old CP6 candidate and reports remain historical evidence, not the release artifact. Run commands from the new integration worktree; its frozen identity and per-file Git mapping are in `output/cp7-integration/candidate.json`. This document does not authorize executing the later write steps below. A future authorization for the complete release may cover all listed steps; gates require evidence, not repeated permission questions for each command.

These instructions supersede the deployment paragraph and generic pre-gallery code-rollback advice in `docs/media-galleries.md` for this release. The former positional invocation of `verify-gallery-deployment.mjs` is intentionally rejected with a migration message: the old application JSON backup is not a complete release baseline or recovery backup. In particular, `scripts/backup-database.mjs` omits `resource_topics` and `site_content_revisions`. Do not use it or its rollback-only restore simulation as evidence of committed migration recovery.

## Confirmed release architecture and gates

| Repository evidence | Actual behavior |
| --- | --- |
| `package.json`, `.github/workflows/ci.yml` | Node 24; CI pins Node 24.11.1 / npm 11.6.2, installs optional packages and Chromium, then runs `npm run check`. CI triggers on PR, `main` push and manual dispatch. It does not run database migration or publish the application. |
| `vercel.json` | Next.js; `npm ci --include=optional`, then `npm run build`. README now matches this configured install command. Build prepares source HTML/assets before `next build`. |
| Fresh Vercel control-plane evidence | Authenticated CLI 59.13.1 reads establish project `prj_x1wwpRjVY46LGAjNcd3QOpAf1ssJ` (`i-hear-website`), team `team_ebxQ8WweOsZkpbvdopoO0A61` (`sansan20036s-projects`, Hobby), GitHub `sansan20036/iHear-website` / repository ID 1289355404 and Production Branch `main`. `autoAssignCustomDomains` is currently true. Revalidate before release. |
| `netlify.toml` | Legacy static routing only; it is not an approved delivery path for the request-time Next.js Banner/API release. |
| `scripts/migrate-database.mjs` | `npm run db:migrate` is the actual runner. It takes an advisory lock, verifies names/checksums of applied migrations, and commits each pending SQL file together with its ledger insertion. CP1 and CP6 use this runner for 023 → 024. |
| `lib/media-gallery-store.ts` | A non-Vercel PostgreSQL store initialization can execute 019/024 DDL and seed without creating the runner's ledger entries. On hosted production (`NODE_ENV=production` and `VERCEL`), that local DDL branch is disabled; hosted PG gallery reads do not seed. The separate content/impact initialization paths below can still write. A GET or starting an app is not a database read-only preflight. |

Release gates: final candidate verification and checks must pass; the real DB must pass the appropriate phase check; a usable native backup and independent restore must exist; writers must stay frozen through the preservation comparison; the real Vercel project/branch and recovery destination must be identified. Stop on any mismatch. Do not fix a ledger, slug, published status or Banner data merely to make a check pass.

## 0. Fresh platform findings and the release-order boundary

The read-only observations were recorded on 2026-10-07 UTC (2026-10-08 Asia/Taipei). The redacted evidence was copied into this worktree's ignored `output/cp7-integration/platform/` directory from the original workspace; it contains no full database URL, password, token or decrypted value. Archive it separately alongside the candidate. [Release gates](../output/cp7-integration/platform/release-gates.json) and [CLI command help](../output/cp7-integration/platform/cli-command-help.json) distinguish documented command semantics from actions not executed.

| Evidence | Established result | Remaining boundary |
| --- | --- | --- |
| [vercel-fresh.json](../output/cp7-integration/platform/vercel-fresh.json), [platform-additional.json](../output/cp7-integration/platform/platform-additional.json) | Both `www.ihearus.org` and `ihearus.org` currently alias Vercel `dpl_5angoHLGKe6ruagB2dyG3bj2Drjx`, READY, Git SHA `365181eb32418a39048bef6d265ba02579a5d349`; apex redirects 308 to www. Production build settings are Next.js, Node 24.x, `npm ci --include=optional`, `npm run build`. | This is a control-plane serving assignment, not a live HTTP/CSP/cache test. |
| [github-fresh.json](../output/cp7-integration/platform/github-fresh.json) | Full CI run 37511470953, event `push`, branch `main`, same SHA, **failed**. GitHub deployment record 6892069078 reports success. `main` is unprotected, rulesets are empty and GitHub Production/Preview environments have no protection rules. | GitHub record ID is not a Vercel deployment ID. Separate monitor/backup/inspect success does not satisfy full CI. No evidence shows CI gates Vercel; do not assume it does. |
| [vercel-fresh.json](../output/cp7-integration/platform/vercel-fresh.json), [database-target-mapping.json](../output/cp7-integration/platform/database-target-mapping.json) | Current `POSTGRES_URL` record `KhSkpobkDZoZxeMB` targets **both Preview and Production**. No branch-specific override was returned. `DATABASE_URL` is absent. `SUPABASE_URL` is production-only. | These sensitive values cannot be read back, even by the authenticated account. The local connection has not been proven equal to Production. |
| [platform-additional.json](../output/cp7-integration/platform/platform-additional.json), [deployment-env-metadata.json](../output/cp7-integration/platform/deployment-env-metadata.json) | Integration resources list is empty. Existing deployment `env` / `build.env` metadata includes POSTGRES_URL and SUPABASE_URL names. | Names do not identify the deployed value or its database. Current project settings are not a verified historic deployment environment snapshot. |
| [access-fresh.json](../output/cp7-integration/platform/access-fresh.json) | Cached CLI works and is authenticated as sansan20036; API network/team/project reads succeed. | Browser CUA failed at helper/kernel startup, so browser state is unknown. The remaining database blocker is missing identity evidence, **not** missing Vercel login or a proven permission denial. |

Before direct SQL, the maintainer must confirm the non-secret mapping for that exact Vercel variable/project: Supabase project ref, any branch identifier, database name, approved direct/session host and role. A password-manager/provider inventory record can supply the mapping without exposing the secret. The local ref `hjc…umi` and transaction-pooler port 6543 alone do not establish it. Obtain the provider's direct/session connection for the migration runner's session advisory lock and native dump; do not invent one by changing the port. No formal DB connection or ledger/schema verification occurred in this round. [Sensitive variable semantics](https://vercel.com/docs/environment-variables/sensitive-environment-variables), [Supabase connection modes](https://supabase.com/docs/guides/database/connecting-to-postgres).

The proposed release path is explicit CI → direct DB preflight → freeze → verified native backup/restore → tracked migration → **staged Production deployment** → smoke → explicit promotion. Actual source boundaries are:

| Stage / source | DB effect |
| --- | --- |
| `npm run build` → `scripts/optimize-static-images.mjs`, `scripts/prepare-public.mjs` / `prepare-academy.mjs` | These source-preparation steps process local files. They do not invoke stores or the migration runner. `app/route.ts` is `force-dynamic`, so Banner SSR is not a build-time static-page fetch. No Production-credential build was executed here; this is not a guarantee about unobserved platform warm-up/health requests. |
| First runtime homepage GET → `lib/public-page.ts:servePublicPage` → `readContentStore` → `lib/content-store.ts:readContentStoreUncached/ensurePostgresSchema` | Opens PG and issues CREATE TABLE/INDEX, legacy-to-`zhHant` INSERT with conflict handling and ALTER RLS even under VERCEL. A public GET therefore is **not read-only**; cold initialization can write or trigger revisions even when the visitor only reads. The parallel `getCurrentSiteMetrics` path in `lib/impact-store.ts` also performs schema initialization and conditional initial seeding. |
| Same SSR `loadHomeBanner` → `listGalleries` / `publicGalleries` | Hosted PG gallery `ready()` skips its local 019/024 DDL branch and reads galleries/assets. Do not attribute file-store Banner seeding to this hosted PG path. The runner must already have applied 024. |
| Routes calling `enforceRateLimit` → `lib/rate-limit.ts:consumeShared` | INSERT/UPDATE into `public.api_rate_limits` is a separate operational write; not every anonymous API GET calls this helper. Public Resources/gallery read routes must not be described as arbitrary admin mutations. |

The identified application-write boundary is the first runtime request/store initialization, which may occur on a generated deployment URL **before any domain switch**. As a conservative release boundary, finish freeze/backup/migration before allowing a deployment/build carrying Production credentials: the current shared Preview setting also exposes those credentials. The record does not claim a DB write was observed during this round's local builds or that simply constructing a lazy PG client executes SQL.

The integration candidate now includes `git.deploymentEnabled:false` and a configuration regression check. This is a local candidate change only; it has **not been pushed or taken effect on Vercel**. Before even a later CI-branch push, review that guard and verify a safe platform path. The documented property disables automatic Git deployments for all branches and has no documented paid-plan prerequisite; Hobby includes CLI and personal Git support. It must be present in the exact pushed commit. This round does not test the first push on this project, cancel existing deployments, or disable manual/CLI/Deploy Hook triggers. To avoid treating an untested first-push guard as isolation proof, first remove the Preview/Production DB sharing under release authorization that includes platform changes, **or** establish and verify platform-side Git disconnection/disablement before pushing. Until one of those prerequisites is recorded, no push or Preview is allowed. Do not enable a paid check or upgrade a plan implicitly. [Git configuration](https://vercel.com/docs/project-configuration/git-configuration), [plan capabilities](https://vercel.com/docs/plans).

The later CI-only path is: verify exact candidate and commit (section 1); push an explicitly named integration branch only after the preceding safety gate; manually run the existing `CI` workflow on that branch; require its full `verify` job to pass for the exact commit. Record run ID, event, head branch, head SHA and conclusion; PR merge-SHA CI is not the same as source-commit CI. The workflow itself has no deploy step or production DB injection. Review any future workflow changes before relying on that fact. A later main update must retain the guard and the exact accepted commit/tree; no force push and no assumption that a successful Vercel status means CI passed.

## 1. Verify the frozen candidate

Run from the same candidate worktree in PowerShell:

```powershell
git rev-parse HEAD
git status --short
node scripts/integration-candidate.mjs verify output/cp7-integration/candidate.json
if ($LASTEXITCODE -ne 0) { throw 'Candidate bytes or preservation baseline changed' }
```

The integration manifest also records the old CP6 candidate, remote commit and integration commit provenance; it protects all 24 original migration bytes/checksums and every original/remote content semantic value. The manifest covers source, configuration, lockfile, all 24 migrations, required scripts, tests and documentation; it excludes dependencies, generated output, credentials and evidence. Its code ID excludes documentation to avoid a report/identifier cycle; its delivery digest includes documentation. It is a **worktree byte manifest**, not a claim that the old HEAD contains these changes. All required new files must be included in the later reviewed commit. Archive the ignored acceptance evidence separately.

Do not regenerate a baseline to hide a mismatch. Investigate it, rerun affected checks and deliberately freeze a new candidate if a real change is necessary. A new checkout can change line endings with Git `core.autocrlf`; the manifest also records Git clean-filtered blob IDs. Use `verify-commit` below to compare the exact committed tree and record the new commit/CI evidence rather than falsely claiming a Windows raw-byte manifest is portable across OS checkouts. Never edit historical SQL to fix that difference.

This integration round authorizes the local checkpoint/merge and candidate delivery commits; the resulting manifest is bound to the reviewed integration ancestry and exact delivery tree. At later release time, use that existing frozen commit: do not create a replacement commit that mixes in new work or regenerate a baseline to excuse it. Run `node scripts/integration-candidate.mjs verify-commit output/cp7-integration/candidate.json HEAD` and require exit 0 before any authorized push. This verifies exact committed paths and Git-filtered blob content, including new files and documentation. A changed HEAD/tree requires deliberate new candidate review. The check rejects symlink/submodule entries but does not distinguish executable from non-executable regular-file mode; this repository uses Node/npm entry points.

## 2. Production preflight: direct SQL only

**Stop here until section 0 establishes the unique Production database mapping.** Use an explicitly injected, narrowly scoped connection in `CP7_READONLY_DATABASE_URL`. The verifier never reads `.env`, never falls back to another URL, imports no store, and makes no API calls. It sets connection-level `default_transaction_read_only=on` and executes a repeatable-read read-only transaction with a 15-second statement timeout. It disables RLS filtering for the transaction so a role unable to see all rows fails instead of producing a misleading partial snapshot. Use an audited read account able to inspect every required table and catalog; do not print its secret.

Prepare a private release directory outside the deliverable. Snapshots contain application records and internal metadata; keep access restricted and encrypt/archive them with the dump. The verifier writes new files exclusively and will not overwrite a baseline.

```powershell
$releaseDir = Join-Path (Get-Location) ('backups/cp7-release-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $releaseDir -ErrorAction Stop | Out-Null
if (-not $env:CP7_READONLY_DATABASE_URL) { throw 'Inject the approved read-only connection first' }
if ($env:POSTGRES_SSL -eq 'disable') { throw 'Remove the insecure local-only Node PG override before production checks' }
$env:POSTGRES_SSL = 'require'
# postgres-js 'require' encrypts but does not itself verify server CA/hostname.
# Record that limitation; do not label this certificate-verified TLS.
# Also inject the provider-approved libpq PGSSLMODE / certificate settings before
# native commands. Node's POSTGRES_SSL and libpq TLS settings are independent.
node scripts/verify-gallery-deployment.mjs --phase pre-024 --database-env CP7_READONLY_DATABASE_URL --snapshot-output "$releaseDir/pre-024.json"
if ($LASTEXITCODE -ne 0) { throw 'Stop: production is not the reviewed 001–023 baseline' }
```

Expected: `verified:true`, `transaction_read_only:on`, `transaction_isolation:repeatable read`, 23 correctly named/checksummed ledger rows, original five named galleries, the old five-ID CHECK, unchanged version/items/PK constraints, RLS, resource relationship/slug uniqueness and guard. The report identifies actual `announcements → announcements` and `calendar → calendar` mappings from 023's reserved seeds. Draft/archived topics or zero published items are valid empty homepage results, not schema faults. Missing/misassigned topics, duplicates or altered constraints are blockers; no automatic publication/renaming/seeding occurs.

If production has already applied 024, do not falsify a pre-024 baseline. Inspect that result, then run `--phase post-024` into a new file; it must show 24 matching ledger rows, the expanded CHECK and a `home-banner` row. An empty Banner is valid. Use that accepted post-024 snapshot as the same-phase baseline for this release and its backup/restore checks. Do not rerun a raw SQL file or delete its migration record. Other intermediate/unknown histories require review before proceeding.

The tool snapshots **every existing public table**, including old galleries/items/video/order, assets, operations, resources, translations, migration rows and revisions. PostgreSQL's exact JSON text preserves array order and bigint digits beyond JavaScript's safe integer range. It also records actual constraints, enabled triggers and RLS. The static reservation check reads the candidate allocator's declared reserved set; behavioral allocation is separately covered by the model tests. It does not change stored names, IDs, slugs or status.

## 3. Freeze writes, back up, and prove the backup is usable

There is **no repository maintenance-mode flag**. The release operator must obtain confirmation from all administrators to stop edits/uploads, pause scheduled jobs/imports/other SQL writers, and arrange platform traffic gating before the backup. Public traffic can write rate-limit or initialization records; for an exact all-public-table comparison, that traffic must also be quiescent. Record the freeze start, responsible operator, paused writers and traffic-gating mechanism. Platform access/gating configuration is a deployment prerequisite, not something this runbook assumes already exists. If the operator cannot establish it, stop the release.



Concrete traffic-gate proposal for the confirmed Hobby project (not applied this round): review and publish a temporary project WAF rule named `cp7-release-freeze`, matching every request path (prefix `/`) with action **Deny**, ordered before other custom bypass rules. Separately account for system bypass rules, which cannot be dismissed by reordering a custom rule. Confirm project/domain coverage, active rule version and absence of effective bypass exceptions; then confirm requests are denied before application execution and wait for already-started requests to drain. The current `ssoProtection:all_except_custom_domains` leaves production custom domains public and is not a freeze. Custom WAF rules are available on all plans; existing rule capacity, permission, precedence and actual coverage still need operator verification. If that gate cannot cover every live ingress, stop instead of claiming a freeze. No rule is created by this document. [WAF rule behavior](https://vercel.com/docs/vercel-firewall/vercel-waf/custom-rules), [Hobby protection scope](https://vercel.com/docs/deployment-protection).

During that later window, pause `production-uptime.yml` and `production-browser.yml` (including any in-progress jobs), external monitors, administrators, importers and direct SQL writers. Inventory the daily application/weekly PostgreSQL backup and monthly rehearsal jobs separately; their schedule or success is not proof of writer isolation. Record their actual targets and overlap. A WAF rule does not stop SQL clients or build-time DB access. Keep application HTTP blocked until the strict post-migration snapshot comparison finishes. For staged smoke only, narrow the reviewed temporary rule to deny traffic **except the release operator's approved IP**, maintain the admin/job freeze, and record any approved initialization/revision writes or rate-limited request rows caused by smoke. Do not later treat those expected post-comparison rows as frozen-baseline corruption. Restore the original traffic policy only after acceptance; direct DB writers remain paused through release validation.

Take a fresh verifier snapshot **after** the freeze, then the dump. Compare again immediately after the dump and before migration. This establishes the recoverable data time point and catches a writer missed by the freeze; it does not make future uncoordinated writes safe. No writer may resume until all release checks are accepted. If any unexpected row/revision difference appears, preserve both snapshots, stop, reconcile the writes and take a new backup under a verified freeze. Do not subtract those differences or restore over them.

Native PostgreSQL 17 tools must be available and compatible with the actual server major version. Check `pg_dump --version`, `pg_restore --version`, and the verifier's reported server version. CP6 rehearses PostgreSQL 17. The commands below use standard libpq environment (`PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSFILE` and approved TLS parameters) injected securely for the **same source** as the read-only URL. Record the intended server/database identity privately; do not print passwords or a full URL. Stop if the two targets differ.

```powershell
node scripts/verify-gallery-deployment.mjs --phase pre-024 --database-env CP7_READONLY_DATABASE_URL --snapshot-output "$releaseDir/frozen-pre-024.json"
if ($LASTEXITCODE -ne 0) { throw 'Frozen baseline failed' }
pg_dump --format=custom --schema=public --no-owner --no-acl --file="$releaseDir/pre-024.dump"
if ($LASTEXITCODE -ne 0) { throw 'Native backup failed' }
pg_restore --list "$releaseDir/pre-024.dump" | Set-Content -LiteralPath "$releaseDir/restore-list.txt"
if ($LASTEXITCODE -ne 0) { throw 'Backup archive cannot be read' }
Get-FileHash -Algorithm SHA256 -LiteralPath "$releaseDir/pre-024.dump" | Format-List
node scripts/verify-gallery-deployment.mjs --phase pre-024 --database-env CP7_READONLY_DATABASE_URL --baseline "$releaseDir/frozen-pre-024.json" --snapshot-output "$releaseDir/after-backup-pre-024.json"
if ($LASTEXITCODE -ne 0) { throw 'Writes occurred after the frozen baseline; stop' }
```

No table data is excluded from this release dump (unlike the scheduled weekly job's rate-limit exclusion). This custom archive contains public-schema DDL/data, not managed `auth`/`storage` schemas, cluster roles, ownership/ACL restoration or external image bytes. Preserve provider-managed recovery/PITR, grants/role configuration and object-storage backups separately; retained asset paths require their corresponding immutable objects. A list/checksum alone is insufficient: restore the dump to a newly provisioned isolated destination using section 7, then compare its pre-024 snapshot to `frozen-pre-024.json`. Keep the production source untouched. Securely encrypt and retain the verified archive offsite before migration; key custody and storage provider configuration remain release-operator responsibilities.

For a database already at 024, substitute `post-024` in the verifier phases/filenames above and below. The native dump commands and unchanged-data comparison remain the same.

## 4. Apply the tracked migration before any new application startup

Only after backup validation, inject the approved writer URL in `CP7_RELEASE_DATABASE_URL`. Set **both** runner variables to the same target; the existing runner itself loads environment configuration, so do not leave a stale URL with higher precedence. Run from the frozen repository root, not a temporary folder with a different migration set.

```powershell
if (-not $env:CP7_RELEASE_DATABASE_URL) { throw 'Inject the approved migration connection first' }
$env:POSTGRES_URL = $env:CP7_RELEASE_DATABASE_URL
$env:DATABASE_URL = $env:CP7_RELEASE_DATABASE_URL
npm run db:migrate
if ($LASTEXITCODE -ne 0) { throw 'Migration failed; retain freeze and inspect runner output' }
node scripts/verify-gallery-deployment.mjs --phase post-024 --database-env CP7_READONLY_DATABASE_URL --baseline "$releaseDir/frozen-pre-024.json" --snapshot-output "$releaseDir/committed-post-024.json"
if ($LASTEXITCODE -ne 0) { throw 'Post-migration preservation mismatch; do not deploy' }
Remove-Item Env:POSTGRES_URL, Env:DATABASE_URL
```

Expected runner output: applied only `024_home_banner_gallery.sql`; 001–023 skipped with matching checksums. The baseline comparison allows exactly: the expanded ID CHECK; one 024 ledger row; the initial `home-banner` photo row when previously absent; and the content revision's single statement-trigger increment/timestamp. Other data and schema remain identical. For an already-024 database, the runner should skip all 24; compare against the accepted frozen **post-024** baseline instead, allowing no differences. Empty Banner remains empty and is never reseeded by verification or runner rerun.

Do not use a local `npm start`, page GET, `db:audit` with unreviewed scope, or store initialization to upgrade/repair the production database. The explicitly tracked runner is the release entry. A failed migration's SQL and ledger insert roll back together; previously committed migration files remain committed. CP1 proves that pre-commit boundary; section 7 covers recovery after commit.

## 5. Stage the exact reviewed application, then promote explicitly

This section is a later authorized operation; nothing here ran during the integration round. Require section 0's safe CI path, full exact-commit CI pass, unique production DB mapping, verified freeze/backup/restore, section 4 preservation pass and an unchanged candidate. Re-read project/team/branch/aliases immediately before staging. Keep the temporary traffic/admin/job gate in effect. Record the previous deployment as investigation evidence, not as a validated rollback target.

Use the authenticated Vercel CLI version reviewed for the release. In this workstation it was cached at `C:/Users/sansa/AppData/Local/npm-cache/_npx/69f9afb961c37556/node_modules/vercel/dist/vc.js` (59.13.1); an absent cache requires an explicitly reviewed replacement, not an implicit latest-version install. `$vercelCli` below must point to that verified entry. Do not pull Production variables into a checkout, upload a credential file, use Preview as a Production DB test, or run a local build with Production credentials.

`--prod --skip-domain` creates a Production-environment build while withholding domain promotion; it does not cancel SQL reads or provide a write freeze. It overrides the currently true auto-assign setting for this command. The subsequent `promote` of that staged **Production** deployment assigns domains without rebuilding; promoting a Preview is a different path that rebuilds with Production configuration and is not this release procedure. CLI 59.13.1 help confirms both commands. The complete `deploy --dry --json --project … --scope … --non-interactive` combination was actually run successfully (exit 0, no deployment) in [argument evidence](../output/cp7-integration/platform/cli-dry-arguments.json); no paid Deployment Checks are assumed. Actual plan/project authorization is still checked on execution. [Deploy CLI](https://vercel.com/docs/cli/deploy), [staged production promotion](https://vercel.com/docs/deployments/promoting-a-deployment).

The first local dry inspection exposed that Git-ignored evidence/generated files were still selected by the CLI (6,361 output files in one sample). The candidate now includes `.vercelignore`. A subsequent [filtered dry comparison](../output/cp7-integration/platform/cli-dry-filtered-upload.json) checked the actual CLI file list against `deliveryFiles` plus tracked/untracked Git inventory: 377 candidate files, 376 regular upload files, only `.gitignore` omitted by the CLI, no extra files, no necessary source omissions and no per-file size/SHA-1 differences. `.private`, `output` and `public` appeared only as zero-byte directory placeholders, with no contained files. `.env.example` and both source catalogs remain included; credentials, runtime data, backups, dependencies and generated artifacts are excluded. This is local packaging evidence, **not an upload or deployment**. Repeat it after final document/candidate freeze and before release; do not copy these interim counts into a claim that a later changed candidate was checked. The manifest's SHA-256/Git mapping remains the candidate identity; CLI SHA-1 here checks the selected local input bytes.

`$releaseDir` remains the private evidence directory from section 2. The following checks and deployment must use the committed integration worktree:

```powershell
node scripts/integration-candidate.mjs verify output/cp7-integration/candidate.json
if ($LASTEXITCODE -ne 0) { throw 'Candidate changed' }
node scripts/integration-candidate.mjs verify-commit output/cp7-integration/candidate.json HEAD
if ($LASTEXITCODE -ne 0) { throw 'Commit is not the accepted candidate' }
$releaseCommit = (git rev-parse HEAD).Trim()
if (-not $vercelCli -or -not (Test-Path -LiteralPath $vercelCli)) { throw 'Use the reviewed Vercel CLI entry' }
node $vercelCli deploy --dry --json --project prj_x1wwpRjVY46LGAjNcd3QOpAf1ssJ --scope sansan20036s-projects --non-interactive > "$releaseDir/upload-inputs.json"
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect deployment inputs' }
# Review upload-inputs.json against the manifest; no .env, backups, output,
# unrelated source, generated local build or unreviewed omission is allowed.
# Require the exact full CI head SHA to equal $releaseCommit before continuing.
node $vercelCli deploy --prod --skip-domain --project prj_x1wwpRjVY46LGAjNcd3QOpAf1ssJ --scope sansan20036s-projects --meta "releaseCommit=$releaseCommit" --non-interactive > "$releaseDir/staged-deployment-url.txt"
if ($LASTEXITCODE -ne 0) { throw 'Staging failed; retain freeze and do not promote' }
```

Inspect the resulting immutable deployment through the control API: project/team, target Production, READY, source commit/input correspondence and absence of new custom-domain assignment. Custom `releaseCommit` metadata is a trace label, not independent proof of uploaded bytes. Save its actual `dpl_...` ID and URL; authenticate to that deployment for staged smoke without submitting admin mutations. HTTP smoke remains capable of the initialization writes identified in section 0; do not call it database-read-only testing. Verify SSR, cards, Academy, old galleries, languages, errors and CSP/cache behavior using the section 6 criteria; the existing hard-coded production browser runner cannot silently be retargeted to the staged URL. If a separately configured staged harness is unavailable, this smoke remains a manual browser gate, not an asserted automated pass.

Only after the exact staged deployment passes and the release authorization covers promotion:

```powershell
# Assign only the actual accepted staged Production ID from the API evidence.
if (-not $stagedDeploymentId -or $stagedDeploymentId -notmatch '^dpl_[A-Za-z0-9]+$') { throw 'Accepted staged deployment ID required' }
node $vercelCli promote $stagedDeploymentId --scope sansan20036s-projects --non-interactive
if ($LASTEXITCODE -ne 0) { throw 'Promotion incomplete; inspect actual aliases before retry' }
```

This is the domain-switch boundary. Re-read both `www.ihearus.org` and `ihearus.org` aliases and require the accepted ID, then execute section 6 against the actual custom domain before reopening writers. A wrong ID, build/test failure, unexpected alias switch or DB difference is a stop. Preserve both deployments and data; do not silently rebuild another worktree, drop Banner rows or switch to an unqualified old binary. `npm run db:migrate` is not part of Vercel's build command. Keep Git automatic deployments disabled until a separately reviewed policy replaces this explicit release path. Reconnecting Git or removing/relaxing the guard requires new checks for exact-SHA CI gating, Preview isolation and Production DB/alias timing; do not silently restore automatic release behavior.

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

With libpq environment changed to that isolated destination and `CP7_RESTORE_READONLY_DATABASE_URL` pointing to the same destination:

```powershell
# The destination must already exist and be empty; pg_restore does not choose it for you.
if (-not $env:PGDATABASE -or -not $env:CP7_RESTORE_READONLY_DATABASE_URL) { throw 'Explicit restore destination required' }
psql -X --set=ON_ERROR_STOP=1 --command="SELECT current_database(), inet_server_addr(), inet_server_port();"
if ($LASTEXITCODE -ne 0) { throw 'Cannot identify restore destination' }
# Verify that identity is the newly provisioned destination, never the source.
# --schema=public archives include CREATE SCHEMA public. Remove only the empty
# destination's default schema; omission of CASCADE makes existing objects a blocker.
psql -X --set=ON_ERROR_STOP=1 --command="DROP SCHEMA public;"
if ($LASTEXITCODE -ne 0) { throw 'Destination public schema is not empty/available; stop, do not add CASCADE' }
pg_restore --exit-on-error --single-transaction --no-owner --no-acl --dbname="$env:PGDATABASE" "$releaseDir/pre-024.dump"
if ($LASTEXITCODE -ne 0) { throw 'Restore failed; do not redirect application traffic' }
node scripts/verify-gallery-deployment.mjs --phase pre-024 --database-env CP7_RESTORE_READONLY_DATABASE_URL --baseline "$releaseDir/frozen-pre-024.json" --snapshot-output "$releaseDir/restored-pre-024.json"
if ($LASTEXITCODE -ne 0) { throw 'Restored data/schema differs from backup time' }
```

Expected: zero data differences, original five-gallery CHECK, original revisions and 001–023 migration ledger, all old images/items/videos/order/operations retained. PostgreSQL's official `pg_get_constraintdef(oid,true)` output is compared for semantic formatting stability; raw definitions remain in snapshots. Native dump/restore can flatten redundant AND grouping introduced by `BETWEEN`. The tool does not blindly strip parentheses or ignore AND/OR differences. Restore of an accepted post-024 backup uses post-024 baseline/phase and preserves an empty Banner unchanged.

This returns data to the frozen snapshot/backup time, **not** to the later release failure time. If the write freeze was maintained, no intended intervening admin edits are lost. If writers resumed or escaped the freeze, keep both databases, identify and reconcile all newer writes/objects before any switch. Do not overwrite them automatically. External media objects referenced by restored rows must remain available; do not delete newer immutable objects during recovery.

Restore completion is a data-recovery checkpoint. Before changing production DB connection settings or routing traffic, verify the intended application against the recovered database in isolation. CP6's current application requires migration 024: a pre-024 restored DB must remain offline until a reviewed application/forward-repair plan is chosen and validated. The runbook does not claim instant service rollback to an unspecified old binary. The operator records the approved application commit, any newly executed forward migration, destination/grants/storage verification and repeated section 6 checks before reopening. If an immediate old-version rollback is a release requirement, it remains a gate until that exact version is separately tested; do not substitute the historical pre-gallery recommendation.

## Local proof and remaining production checks

Run `npm run test:home-focus-recovery` only for the disposable Docker PostgreSQL 17 rehearsal. It uses a uniquely named loopback-only container, applies the actual runner through 023, writes representative records, produces a public custom dump, commits 024, restores to a second database and compares complete data/schema/revisions/ledger. It invokes the deployment verifier before/after/after restore and proves those checks do not mutate state. The administrator-cleared post-024 Banner no-reseed guarantee retains CP1's earlier evidence; it is not one of this rehearsal's 43 checks. Only its own container is cleaned up. Commands, versions, dump hash, raw/normalized constraints and comparison evidence are under `output/cp6-home-focus/recovery/<run-id>/`; the final run is linked by the CP6 report.

These CP6 files remain in the **original** workspace/archive under `output/cp6-home-focus/recovery/3c2ec64c-f933-43e9-8846-a8890b39e6d2/`; they were not rerun or copied into the integration worktree. The completed rehearsal is archived run `3c2ec64c-f933-43e9-8846-a8890b39e6d2` (`report.json`): **43 passed, 0 failed, 0 skipped, exit 0**, PostgreSQL/pg_dump/pg_restore 17.11 on Docker Desktop, Windows host. Its archived `restore-diff.json` shows all 21 public tables plus columns/defaults, constraints, indexes, RLS, triggers, functions, policies and sequences restored. Before/after data+schema digest: `7b3487222c1c05c4237644ac7f0e3d477eb02b277113e20767d3fb5de57d9b14`; archive SHA-256: `94b7570df9199c1cd4cfbfec59d94d0af40a8d7345011cfd27e67d0c5d875dcd`. The archived `commands.json` preserve actual arguments and exit codes with database secrets redacted. Earlier attempts remain as diagnostic evidence: raw CHECK parentheses after restore and the existing empty `public` schema exposed and motivated the narrowly scoped fixes above. They are not counted as successful runs.

The 22-case deployment-verifier unit suite is `npx --no-install vitest run tests/gallery-deployment-verifier.test.mjs` and is included in Operations. Local proof does not establish the production database's ledger/ID mapping, managed role/storage configuration, provider traffic controls or effective CDN/CSP. The fresh control API now establishes the current project, Production Branch and domain assignment; revalidate them at release time. Database identity/ledger remain unresolved, and no platform changes, CI dispatch, Preview, production build, migration or promotion occurred in the integration round. Those remain explicit execution-time gates above. BFCache, screen-reader and other-engine evidence must be described exactly as measured in the CP6 report; this runbook grants no new exemption from existing browser support requirements.
