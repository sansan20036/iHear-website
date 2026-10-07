# CP6 — Homepage integration acceptance and release preparation

Status: **passed — stopped at CP6**, 2026-10-08. Final integration **8/8**, committed PostgreSQL recovery **43/43**, and the complete required check chain passed. This checkpoint does not authorize or execute production database access, a Git push, production migration or deployment. The separately executable release procedure is [the release and recovery runbook](home-focus-release-runbook.md).

## Baseline and candidate scope

The observed HEAD at the start remains `fd6a93dd433da347ca4e5d412c25d6f5280fc57f`. It was read again, not inferred from the earlier inventory. The starting worktree contained **47 modified/untracked entries**, including accepted CP0–CP5 work and an untracked generated `tsconfig.tsbuildinfo`. No reset, commit or cleanup of that work was performed. See [the captured start](../output/cp6-home-focus/baseline.json).

The preservation reference is the pre-existing [CP5 trusted baseline](../output/cp5-home-cards/baseline.json), whose SHA-256 was recorded before CP6 edits, together with CP5's [preservation result](../output/cp5-home-cards/preservation.json). This retains **24 historical migration byte hashes and runner checksums**, **311 existing semantic content values** (including the earlier 303), and 30 protected files. CP5 had added ten slots after that baseline: CP6 additionally protects all **321 actual starting values**. Comparison uses page/key and complete semantic value, mode and limits, excluding only generated occurrence/line metadata. It does not substitute a count check or invent a newer baseline to forgive differences.

Reviewed CP1–CP5 reports, the homepage/SSR/controllers and notification contracts, package scripts, migration runner, legacy backup/verifier, CI workflows, hosting settings and browser acceptance scripts. No repository instructions or differently named checkpoint plan supersede this CP6 boundary.

The candidate program identity is:

```text
cp6-f30a433676f81d7a868e5a1a699a7a4505ab879fdb513b81dce990c0c1c5b61c
```

[The frozen check input](../output/cp6-home-focus/check-input.json) identifies the exact program used for the final `npm run check`. [The final deliverable manifest](../output/cp6-home-focus/candidate.json) adds this completed report and records every deliverable path, byte length, raw SHA-256 and Git clean-filtered blob ID. It covers tracked and required untracked source, configuration, lockfile, assets, all migrations, scripts, tests and documentation. It excludes credentials/local `.env`, dependencies, generated `public`/`.private`/`.next`, output/backups and build metadata. No generated asset was hand-edited.

The code identity excludes documentation to avoid embedding a report's own hash inside itself. The separate delivery digest and per-file hashes include documentation. Thus the report can be finalized after checks without changing the tested code identity. The manifest is a **worktree candidate**, not a claim that these files are already in HEAD. `verify` checks current raw bytes and added/missing paths; future `verify-commit` checks exact committed paths and Git-clean-filtered content, including documentation. Git's current `core.autocrlf=true` can legitimately make committed LF blobs differ from Windows raw bytes. Historical migration bytes are never rewritten to accommodate this. Executable versus non-executable regular-file mode is not compared; the present repository has no executable-mode entries and invokes scripts through Node/npm.

## CP6 changes, distinct from earlier work

| File | CP6 change and reason |
| --- | --- |
| `scripts/verify-gallery-deployment.mjs` | Replace the obsolete exactly-five-gallery/partial-JSON-backup check with explicit pre-024/post-024, truly read-only PostgreSQL verification, named identities, migration ledger/checksums, constraints, topic/slug protection and complete preservation snapshots. Reject the obsolete positional interface with actionable guidance. |
| `tests/gallery-deployment-verifier.test.mjs` | 22 focused tests for identity, empty Banner, old payload/video/title compatibility, ledger/checksum/constraint and fixed-topic failures, exact preservation, schema deparser comparison and read-only CLI scope. |
| `scripts/rehearse-home-focus-recovery.mjs` | Disposable PostgreSQL 17 native backup → committed real migration → separate-database restore, with exact data/schema evidence and verifier non-mutation checks. |
| `scripts/home-focus-candidate.mjs` | Freeze and verify the full deliverable; preserve trusted migrations/content; distinguish code identity, documentation-inclusive digest and Git-normalized commit content. |
| `tests/home-focus-candidate.test.mjs` | Four tests for deliverable exclusions/inclusions, changes/additions/deletions, documentation identity handling and real isolated Git/CRLF commit comparison. |
| `tests/home-focus-integration.smoke.mjs` | Six joined Chromium scenarios plus bounded Firefox/WebKit checks on a production build; real isolated admin API writes, race controls, layout-shift records, real navigation/BFCache diagnostics and screenshots. |
| `tests/public-pages.smoke.mjs` | Use a unique OS-temp file store and clear external DB/storage URLs. A public GET may initialize stores, so previous HTTP read-only assertions alone were insufficient isolation. |
| `package.json` | Include the 26 new verifier/candidate tests in Operations; expose explicit integration/recovery/candidate/deployment-verifier commands. Keep the existing full check sequence. Docker and extra engines remain separately invoked local acceptance steps. |
| `docs/home-focus-release-runbook.md` | Executable candidate, read-only preflight, freeze/backup, migration, Git/Vercel release, cache/CSP and committed-recovery steps with concrete stop conditions. |
| This report | Candidate linkage, test provenance, preservation, evidence and remaining release gates. |

Relative to the starting candidate, only the three already-existing files `package.json`, `scripts/verify-gallery-deployment.mjs` and `tests/public-pages.smoke.mjs` change; the other seven files above are additions. No file is deleted. The application's homepage, controllers, stores, API contracts, migration runner, all 24 SQL files and CP1–CP5 reports remain byte-for-byte at the accepted starting state. No CP6 content slot is added. Earlier dirty work is retained rather than attributed to this checkpoint.

## Joined production-build acceptance

The integration harness starts `next start` on loopback port 3224, `NODE_ENV=production`, forced file-store mode and a unique `ihear-cp6-browser-*` OS-temp data directory. External PostgreSQL/Supabase URLs are blank. Each test author has a separate local session identity. Browser fixtures are not production records. The final build ID is **`CVZVtPWHsUBxHTEH0E1sO`**; the harness asserts it has not changed at completion.

Writes use actual authenticated media/Resources admin APIs in another browser context, then real store/public reads. Specific races hold a real response body or image decode; 503 paths deliberately intercept only the selected endpoint. Tests emit the existing BroadcastChannel `"updated"` protocol after admin API writes. This proves real persistence plus notification-driven public refresh, **not** natural admin-UI-to-cross-tab notification end-to-end behavior; existing admin/CP4/CP5 regressions separately retain their notification coverage.

| Final integration group | Behavior verified |
| --- | --- |
| 01 Admin → open homepage/new SSR | Photo uploads and Banner/announcement/calendar edits persist through actual admin routes; the open page receives the new content; a separate fresh homepage request contains the same latest Banner version without rebuild. Resources arrives independently. No-JS keeps localized first-photo content and basic resource links. |
| 02 Withdrawal/empty/authorized restore | Hidden active photo is removed while its old decode is held; draft/moved resources become empty. A successful empty Banner removes its position, late old decode cannot revive it, and later newly authorized photo/republished resources render normally. |
| 03 Failure isolation/recovery | Resources 503 retains prior cards and operable Banner; Banner body exceeds five seconds and aborts while Resources updates successfully. Each recovers independently; tutor links remain usable. Initial error offers retry, with focus returned to the surviving resource link. |
| 04 Interaction during slow reads | Both modules can have one request each concurrently, with one merged trailing read per module. Reorder preserves the valid active item ID; late responses use current language; unchanged CTA retains focus. Long text, native keyboard order/names and 320/390/768/1024 layout are checked. |
| 05 Lifecycle/real navigation | Hidden boundary pauses the two owned 15-second schedules, return calibrates, actual browser offline/online updates correctly, and actual navigation to `/about` and history return reads new data. No duplicate owned schedules are observed. Actual versus simulated visibility/BFCache evidence is separated below. |
| 06 Existing paths/input | Ready announcement/calendar CTAs land and focus actual Resources categories. Tutor form/guide anchors exist. Legacy stories video cover and its established YouTube destination remain present. Chromium CDP touch changes slides horizontally while vertical gestures scroll; reduced-motion removes the image transition. External YouTube playback is not claimed. |
| Firefox / WebKit (one group each) | Limited initial screen/keyboard operation, real admin update, withdrawal, restore and Resources-failure/Banner-operation isolation. These are bounded engine checks, not the complete Chromium suite. |

The unchanged CP3–CP5 suites additionally rerun the detailed stale/empty/invalid snapshot, old-request-finally, version regression, delayed decode, lifecycle generation, structured/same-page notification, 10-second initial card ceiling, 10-second shared revision and 15-second per-module refresh cases. Manual looping remains manual; no autoplay is introduced. Resources still uses one complete client snapshot (`items`, `topics`, `guidesTakeover`), independent from Banner SSR. Gallery versions and Resources request generations are not interchanged; Resources still has no comparable server snapshot version.

Final integration: **8 groups passed, 0 failed, 0 skipped; exit 0**. See [machine result](../output/cp6-home-focus/browser-results.json) and [execution log](../output/cp6-home-focus/browser-final.log). Runtime: Windows x64 `10.0.26200`, Node `24.11.1`, Playwright `1.62.0`; matched Chromium **151.0.7922.34 / revision 1234**, Firefox **153.0 / revision 1538**, WebKit **26.5 / revision 2336**. No engine is skipped. Eleven focus-area screenshots were saved; representative desktop/tablet/mobile/empty/error/no-JS and engine images were visually inspected as well as asserted in-browser.

## Layout, CLS and environment boundaries

The unchanged CP3 rules remain: desktop ≥1024 has 7:3 columns, 24px gap and Banner minimum 420px with preferred 16:9; 768–1023 stacks Banner above three horizontal cards; <768 stacks cards and separates 16:9 image from copy without the desktop minimum. Empty Banner removes its entire reserved position. Long card copy uses the accepted bounded teaser clamp and category CTA rather than overflowing. The final screenshots cover [English 320](../output/playwright/cp6-home-focus/integrated-long-320-en.png), [Traditional Chinese 390](../output/playwright/cp6-home-focus/integrated-long-390-zhTW.png), [Simplified Chinese 768](../output/playwright/cp6-home-focus/integrated-long-768-zhCN.png), [English 1024](../output/playwright/cp6-home-focus/integrated-long-1024-en.png), [desktop ready](../output/playwright/cp6-home-focus/integrated-ready-1024.png), [error 320](../output/playwright/cp6-home-focus/integrated-error-320.png), [empty 390](../output/playwright/cp6-home-focus/integrated-empty-390.png), [no-JS 390](../output/playwright/cp6-home-focus/integrated-no-js-390.png), [touch/reduced motion](../output/playwright/cp6-home-focus/integrated-touch-reduced-390.png), [Firefox](../output/playwright/cp6-home-focus/firefox-ready-1024.png) and [WebKit](../output/playwright/cp6-home-focus/webkit-ready-1024.png).

Layout-shift evidence is captured through `PerformanceObserver` before application initialization. Raw entries include timestamp, source rectangles and `hadRecentInput`. Phase membership uses entry start time against recorded `performance.now()` markers, not the delayed observer callback time. **CLS is the maximum eligible session-window score**, splitting at a ≥1-second gap or ≥5-second duration; only the standard recent-input exclusion applies. Per-phase sums are labeled sums, not CLS. Designed ready/empty changes are not subtracted. Zero-entry phases are retained in `browser-results.json.measurements`.

| Observed sequence | New phase entries / eligible phase sum | Whole observed-page maximum session window |
| --- | --- | --- |
| 1024 × 950 initial SSR, cards deliberately pending | 1 / `0.0255420926` | `0.0255420926` |
| Same page: release successful Resources body | 0 / `0` | Still `0.0255420926` |
| 390 × 950: withdraw active photo and both card items | 1 / `0.0011837204` | Recorded together with the next transition below |
| Same mobile page: ready → empty | 1 / `0.2998273215` | `0.3017248982` including initial/withdrawal entries in that window |
| Same mobile page: authorized empty → ready | 1 / `0.2998273215` in a new session window | Maximum remains `0.3017248982` |
| 1024 long-copy page: programmatic language switch after slow update | 0 / `0` | Initial window `0.0255420926` remains maximum |

The initial desktop source rectangles identify existing lower introduction elements (`hero-photo`, `hero-sub`, `swoosh`, `hero-tagline`, `fc1`); no new focus-area node is listed in that entry. This is source attribution, not proof of an unmeasured causal timing mechanism. Mobile removal/restoration moves the cards and following page content because CP3 requires the empty Banner reservation to disappear; those substantial changes remain fully counted and can visibly move a visitor's content. These are local controlled observations, not field percentiles or a Lighthouse score. No prior numeric CLS release threshold was found, so this report does not invent a zero-score gate or label `0.3017` as good performance. Revising empty-state spatial behavior would require a separately reviewed change to the accepted layout contract.

BFCache was attempted with actual API traffic and no-store headers intact. Chromium launches with Playwright's default `--disable-back-forward-cache` argument removed. Real `/about` navigation then history return reported navigation type **`back_forward`**, **`pageshow.persisted=false`**, and reasons **`masked`**, **`response-cache-control-no-store`**, **`response-cache-control-no-store-with-js-network-request`**. Normal history return and updated content pass; **actual BFCache restoration did not occur**. No repeated attempts changed the cache contract to manufacture a hit. CP4/CP5 synthetic persisted-event/lifecycle race branches were rerun separately and do not establish a real hit. Headless bring-to-front did not hide the original tab, so the hidden/visible boundary is explicitly simulated; real browser-context offline/online is separately verified. After return, exactly two homepage-owned 15-second intervals remain (one per module); an unchanged generic gallery interval is recorded separately rather than incorrectly counted as a duplicate.

Actual screen-reader interaction remains **unverified**. Keyboard, accessible-name, focus and hidden-control assertions do not establish Narrator/NVDA/VoiceOver output. A Narrator executable exists locally, but no usable automated interactive screen-reader session was established. Playwright WebKit on Windows is **not Safari/iPhone**; native mobile pinch/assistive technology and a full browser-matrix regression remain outside the bounded check.

## Read-only deployment verifier

The old verifier required exactly five collections and used a partial application JSON backup. CP6 instead supports explicit `--phase pre-024|post-024`, `--database-env`, `--baseline` and `--snapshot-output`. It never loads `.env`, imports an application store, starts Next or calls an API. The PostgreSQL connection starts with `default_transaction_read_only=on`; snapshots run in repeatable-read/read-only with statement timeout and `row_security=off` to fail when an audit role cannot see complete rows. Real before/after snapshots prove that pre-, post- and restored-state checks do not write.

- Required identities are the original `tutoring`, `outreach`, `home`, `stories`, `impact`, plus `home-banner` only in post-024. Empty Banner is valid; Banner photos-only and nullable multilingual title preserve the accepted contract. Existing legacy photos/video/omitted-title payloads remain valid.
- Applied migration **names and normalized checksums**, not just row count, must match 001–023 or 001–024. Actual named gallery ID CHECK, PK/items/version constraints, RLS and resource relationship/slug protection are checked. No SQL is auto-applied.
- The actual 023 system ID/slug pairs `announcements → announcements`, `calendar → calendar` are required. Draft/archived or no public records is a valid data state. Missing/misassigned/duplicate identities or broken constraints are blockers. No slug/name/status is rewritten and no topic is published.
- General allocation must still reserve both system slugs; the script checks source reservation, while existing model tests exercise behavior and system seed compatibility. The homepage continues to resolve actual IDs from public slugs, not assume equality.
- All public tables are snapshotted with PostgreSQL-produced JSON text, preserving microsecond timestamps, bigint digits beyond JavaScript's safe range and JSON array order. The deployment CLI compares relation/RLS metadata, constraints and enabled triggers. The separate recovery rehearsal additionally compares columns/defaults, indexes, policies, functions and sequences. Backup-time data is not limited to galleries; the CLI's schema scope is not overstated as the complete recovery comparator.
- Allowed pre→post differences are exactly the expanded ID CHECK, new 024 ledger row, first-time Banner seed row and existing content revision trigger increment/timestamp. A same-phase comparison permits no changes. A snapshot cannot silently excuse arbitrary administrative writes.

The local/unit evidence proves this verifier's behavior; actual production IDs, ledger, constraints, privileges and allocator deployment still require the runbook's direct read-only preflight. Public GET is explicitly excluded from that preflight because initialization can write/upgrade.

## Committed-migration recovery proof

Final command: `npm run test:home-focus-recovery` — **43 checks passed, 0 failed, 0 skipped; exit 0**. [Run report](../output/cp6-home-focus/recovery/3c2ec64c-f933-43e9-8846-a8890b39e6d2/report.json), [redacted exact commands/exit codes](../output/cp6-home-focus/recovery/3c2ec64c-f933-43e9-8846-a8890b39e6d2/commands.json), [environment](../output/cp6-home-focus/recovery/3c2ec64c-f933-43e9-8846-a8890b39e6d2/environment.json).

PostgreSQL server, `pg_dump`, `pg_restore` and `psql` are **17.11**. Docker Desktop 4.54.0 / client-server 29.1.2 runs `postgres:17-alpine` pinned in evidence by image digest. A uniquely named loopback-only disposable container has no host data volumes. No production URLs or application stores are consulted. Only that container is removed after the rehearsal.

1. In database A the actual migration runner applies 001–023. Existing galleries contain representative photo/video, title/missing-title, metadata, ordered arrays, asset/operation rows and multilingual Resources with published/draft topics. Revision precision includes a bigint beyond JS's safe integer range.
2. Preserve [023 snapshot](../output/cp6-home-focus/recovery/3c2ec64c-f933-43e9-8846-a8890b39e6d2/before-023.json), including CHECK, revisions and ledger; use native `pg_dump --format=custom --schema=public --no-owner --no-acl`. All public table data is included, including rate limits; no scheduled-backup exclusion is copied.
3. The **actual runner commits 024** in A. A separate connection sees its ledger and Banner row. [Committed snapshot](../output/cp6-home-focus/recovery/3c2ec64c-f933-43e9-8846-a8890b39e6d2/after-024-committed.json) and [explicit expected-difference preservation](../output/cp6-home-focus/recovery/3c2ec64c-f933-43e9-8846-a8890b39e6d2/upgrade-preservation.json) confirm only the four listed changes.
4. Create separate empty database B, verify its public schema has no objects, remove only that empty default schema without CASCADE, then `pg_restore --exit-on-error --single-transaction --no-owner --no-acl` into B. Source A stays committed at 024.
5. B returns to the original 023 ledger, CHECK, all data/revisions and schema: [restored snapshot](../output/cp6-home-focus/recovery/3c2ec64c-f933-43e9-8846-a8890b39e6d2/restored-023.json), [zero-difference comparison](../output/cp6-home-focus/recovery/3c2ec64c-f933-43e9-8846-a8890b39e6d2/restore-diff.json). All 21 public tables and eight schema components compare successfully. Pre/post/restored verifier non-mutation reports are in the same directory.

Data/schema digest before and after restore: `7b3487222c1c05c4237644ac7f0e3d477eb02b277113e20767d3fb5de57d9b14`. Archive: **121,014 bytes**, SHA-256 `94b7570df9199c1cd4cfbfec59d94d0af40a8d7345011cfd27e67d0c5d875dcd`; [backup manifest](../output/cp6-home-focus/recovery/3c2ec64c-f933-43e9-8846-a8890b39e6d2/backup.json).

Raw CHECK definitions are retained. Native dump/restore re-parses redundant parentheses around AND/BETWEEN. The comparator uses PostgreSQL's own `pg_get_constraintdef(oid,true)` for stable deparsed definitions, not regex removal of parentheses; unit tests retain meaningful AND/OR differences. See [deparser comparison](../output/cp6-home-focus/recovery/3c2ec64c-f933-43e9-8846-a8890b39e6d2/constraint-deparser-comparison.json). Earlier diagnostic runs exposed this representation issue and the archive's CREATE SCHEMA versus an existing empty public schema; both were corrected narrowly. The failed/earlier diagnostic runs remain in output and are not counted as final passes.

This is **recovery after a committed migration**, distinct from CP1's already-proven failed-transaction rollback. CP1's nine real PG contract/concurrency/transaction cases are reused because store, migration and runner bytes are unchanged. The no-reseed-after-admin-clear proof also remains CP1 evidence, not a new claim about the 43 recovery checks.

The archive covers public DDL/data, not provider-managed auth/storage schemas, cluster roles/ACLs, object bytes or service routing. Production must preserve those through its provider procedures. The runbook freezes all admin/direct/automated writers and relevant public traffic, establishes backup-time snapshots and rejects unexpected intervening writes. Restore goes into another database and recovers **backup-time data**, not edits after that time. No destructive down migration or deleting Banner rows is offered. No specific old application binary was tested; neither “old code + upgraded DB” nor instant service rollback to restored 023 is an approved path. Restored pre-024 stays offline until an exact application/forward-repair plan is validated.

## Executed checks and provenance

[Full check log](../output/cp6-home-focus/check.log) and [content log](../output/cp6-home-focus/content-check.log) correspond to the frozen program and final build. Every command below completed with exit 0. Counts are reported by the actual suite; scenario/check totals are not presented as interchangeable unit-test counts.

| Command / child of `npm run check` | Result | Provenance |
| --- | --- | --- |
| `npm run content:check` | 321 logical slots / 13 pages verified | Re-executed |
| `npm run lint` | Passed | Re-executed within full check |
| `npm run typecheck` | Passed | Re-executed within full check |
| `npm run test:api` | 427/427, 0 failed/skipped | Re-executed |
| `npm run test:operations` | 73/73, 0 failed/skipped (47 existing + 22 verifier + 4 candidate) | Existing regression + CP6 additions |
| `npm run test:e2e` | 87/87, 0 failed/skipped | Re-executed existing Playwright suite |
| `npm run test:home-banner-controller-contract` | 24/24, 0 failed/skipped | Re-executed controlled races |
| `npm run test:home-quick-cards-contract` | 29/29, 0 failed/skipped | Re-executed controlled races |
| `npm run build` | Passed; `CVZVtPWHsUBxHTEH0E1sO` | Final production build |
| `npm run test:public-pages` | 13 public routes plus legacy/unknown-route assertions passed | Re-executed with corrected data isolation |
| `npm run test:home-banner-ssr` | 12/12, 0 failed/skipped | Re-executed CP3 production-build cases |
| `npm run test:home-banner-controller` | 16/16, 0 failed/skipped | Re-executed CP4 production-build cases |
| `npm run test:home-quick-cards` | 16/16, 0 failed/skipped | Re-executed CP5 production-build cases |
| `npm run test:media-admin` | Existing gallery workflow passed; Banner 10/10, 0 failed/skipped | Re-executed real admin upload/conflict/retry/empty/video flows |
| `npm run test:resources-admin` | Workflow passed | Re-executed draft/publish/order/hide/conflict/localized UI |
| `npm run test:team-visibility` | Workflow passed | Re-executed real API/editor/conflict/public-filter regression |
| `npm run check` | Complete chain passed, exit 0 | Required final aggregate gate |
| `npm run test:home-focus-integration` | 8/8 groups, 0 failed/skipped | New CP6 production-build integration and engines |
| `npm run test:home-focus-recovery` | 43/43 checks, 0 failed/skipped | New committed PostgreSQL recovery proof |
| `node scripts/home-focus-candidate.mjs verify output/cp6-home-focus/candidate.json` | Passed; 356 deliverable files | Final bytes and candidate verification |
| `git diff --check` | Passed | Working-tree whitespace check |

The new verifier/candidate unit tests also passed independently before the full gate. The preliminary integration run passed 8/8 on the earlier CP5 build but is **not** final-candidate evidence; its results are retained under `output/cp6-home-focus/preliminary`. Its only harness repair excluded unrelated legacy-gallery timers from the two homepage-controller timer count. No product logic was changed to obtain a pass. There is no claim that a skipped engine or failed preliminary attempt passed.

CP3 and CP4 re-execution evidence uses [CP3](../output/playwright/cp6-home-focus/cp3-regression/results.json) and [CP4](../output/playwright/cp6-home-focus/cp4-regression/results.json). CP5 and CP2 scripts have fixed historical output paths; current results/screens were additionally copied into [CP5](../output/playwright/cp6-home-focus/cp5-regression/results.json) and [CP2](../output/playwright/cp6-home-focus/cp2-regression/results.json). Original CP5 top-level evidence was archived before its rerun and restored to its historical path afterward. Embedded screenshot paths in copied results can retain the old absolute directory; the corresponding copied filenames are beside the CP6 result. No prepare/build ran concurrently with a browser reading prepared assets.

## Release gates and remaining limits

The runbook is tied to the actual repository: Node 24 / pinned CI 24.11.1, npm 11.6.2, `npm run check`, actual `npm run db:migrate`, Next.js/Vercel install/build settings. CI runs checks but does not migrate or deploy; the real Vercel Production Branch/Git integration must be confirmed externally. Production push may trigger deployment without waiting for CI, so the same release commit needs successful full CI through an approved non-production/PR/manual path first. No Netlify static path or invented automatic migration is substituted.

| Remaining item | Honest scope / action required |
| --- | --- |
| Production DB | Not contacted. Verify actual 023/024 ledger/checksums, CHECK, identities, topics, grants and storage before release, using the direct read-only tool. No API/store initialization as preflight. |
| Production freeze and backup | Not executed. Establish actual traffic/writer freeze, native backup and independent restore, managed auth/storage/ACL recovery, offsite encryption/key custody. Missing operational control is a release blocker. |
| Application rollback | No exact old binary qualified. Use the documented separate-DB recovery and validate the intended application before switching; if instant old-version rollback is required, it is still a release gate. |
| Production migration/push/deploy | Not executed. Verify exact candidate commit and prior successful CI, then separately authorize the actual production branch and platform flow. |
| Effective CDN / CSP | Not verified on the production domain. Local source/responses and configured policy are separate evidence; enforcing CSP, Report-Only and absent policy must not be conflated. |
| Request cancellation | Browser abort/body deadlines are tested. CP3's 1-second SSR wait does not cancel underlying store/SQL work; late completion/rejection is consumed. This remains unchanged. |
| Resource server ordering | No server snapshot version; guarantees use single in-flight plus request/lifecycle ownership, not invented gallery versions or client timestamps. |
| BFCache / native visibility | Final observed values recorded above/below; synthetic branches are not actual persisted restoration. |
| Accessibility and native platforms | Actual screen reader and Safari/iPhone not verified; bounded Firefox/WebKit tests do not replace them or waive an existing support gate. |
| Layout shifts | Report measured scores and sources, including intended state changes. No new CLS=0 or Lighthouse gate is invented; existing requirements remain in force. |

Local cache checks retain homepage/public media `private, no-store, max-age=0` and CDN no-store; Resources `no-store`; shared revisions' existing 3-second CDN policy; valid versioned images' one-year immutable cache. The rerun CP3 suite verifies a real uploaded versioned image and a browser with the configured enforced CSP injected by the harness. Local Next alone does not prove Vercel has actually delivered that CSP or obeyed its cache configuration. The release runbook records actual headers, edge observations and browser behavior; Report-Only is not enforcement evidence.

Final preservation: **24/24 migration raw bytes and runner checksums unchanged; 311/311 trusted CP5 semantic values and all 321/321 actual starting values unchanged; 30/30 protected files unchanged**. The final manifest's `cp6Changes`, starting/final status and per-file mapping distinguish the three CP6 modifications and seven additions from retained prior work. Source identity matches the frozen check input; [validation linkage](../output/cp6-home-focus/validation-summary.json) records the build, result hashes and final candidate verification. No production database, push or deployment was performed.

**CP6 本機整合驗收與部署準備通過，候選版本已固定；正式資料庫查核、備份、migration、發布及發布後 CDN／CSP 驗證尚未執行。**

Stopped at CP6. Actual BFCache restoration, real screen-reader/native Safari/iPhone interaction and formal environment checks remain limited as recorded above; no existing release requirement is waived.
