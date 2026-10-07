# CP5 — Homepage Quick Cards and Resources Refresh

Status: **passed — stopped at CP5**, 2026-10-08. Homepage quick-card production-build acceptance: **16 passed, 0 failed, 0 skipped; exit 0**. Required regression, content, lint, typecheck, build and preservation checks passed. No deployment or production database changes were performed.

## Baseline and scope

Observed HEAD: `fd6a93dd433da347ca4e5d412c25d6f5280fc57f`. The initial working tree had **41 modified/untracked entries** from earlier checkpoints. It was recorded and preserved, not assumed clean or reset. `output/cp5-home-cards/baseline.json` records that status, raw migration hashes and runner checksums, 30 protected files, source copies and the starting content catalog.

The request names 303 existing content values. The actual accepted CP4 result already contains **311 slots**, including those 303 and CP4's eight interaction additions. CP5 protects all 311 starting semantic values, checks the separately recorded 303-value baseline as well, and adds ten slots through the existing generator: **321 total**. Occurrence/line metadata may move with source HTML; existing values, modes and limits must remain identical. The old tutor-link value is retained in an inert source template rather than silently changed into a different destination label.

Reviewed CP1–CP4 reports, the homepage source and dedicated hooks, Resources route/public projection/store/model/seed/allocator, Resources anchor resolution, existing form and guide destinations, content-slot language handling, CP4 request/lifecycle behavior and built-browser tools. No differently named checkpoint plan supersedes the user-defined CP5 boundary. The Banner SSR loader/renderer, Banner controller, shared revision service, generic gallery controller and complete Resources-page controller remain unchanged.

## Files changed relative to the CP5 starting worktree

| File | Reason |
| --- | --- |
| `assets/home-quick-cards.js` | New homepage-only snapshot validation, card projection, independent state/rendering, shared Resources request and lifecycle handling. |
| `index.html` | Initial loading/Skeleton and usable basic links, persistent dynamic nodes, localized state-label template, no-JavaScript guidance and confirmed tutor resource destinations. |
| `assets/home-focus.css` | Compact resource teasers, fixed content reservation, Skeleton, retry/focus treatment and card text clamping within the existing CP3 grid. |
| `assets/site.js` | Three-language fixed card copy for the ten added slots. |
| `scripts/prepare-public.mjs` | Version/inject the dedicated controller on the homepage after shared live content; generate public/private assets through the existing workflow. |
| `lib/resource-input.ts` | Add `announcements` and `calendar` to the general slug allocator's reserved set. No mutation of stored topic records. |
| `tests/resource-topic-model.test.mjs` | Reserved-slug allocation and existing system-seed/initialization compatibility checks. |
| `tests/home-quick-cards.test.mjs` | Actual controller in controlled Chromium, including whole-snapshot validation, projection/render isolation, timeout/body and lifecycle races. |
| `tests/home-quick-cards.smoke.mjs` | Production-build homepage acceptance with isolated file-store fixtures, real Resources mutations, controlled browser boundaries and screenshots. |
| `tests/home-banner-ssr.smoke.mjs`, `tests/home-banner-controller.smoke.mjs` | Adapt old card assumptions to CP5 loading/basic links and the single independent Resources request; support separate CP5 regression evidence destinations. |
| `tests/home-banner-controller.test.mjs` | Verify retained card-link focus by node identity and the new loading destination `/resources`, replacing obsolete pre-CP5 category-link expectations. |
| `package.json` | Add `test:home-quick-cards-contract` and `test:home-quick-cards` to the existing check workflow. |
| `data/content-slots.json`, `docs/content-slot-inventory.md` | Generated 321-slot catalog; ten additions and preserved prior semantic values. |
| This report | Contract, verification history, preservation evidence and remaining boundaries. |

This table is not an attribution of every `git diff HEAD` change to CP5. The earlier dirty files and accepted CP0–CP4 work remain in place. No migration, Resources schema/store/projection, media contract or existing production data is changed.

## Actual sources, identities and destinations

| Card | Source and selection | Ready destination | Loading / empty / error destination |
| --- | --- | --- | --- |
| Announcements | One public Resources snapshot; find topic whose `slug === "announcements"`, then its real `id`; select the first associated item by ascending `sortOrder`, then `id.localeCompare`. | `/resources#announcements` | `/resources` |
| Calendar | Same snapshot; find `slug === "calendar"`, resolve the actual topic ID, then use the same item ordering. | `/resources#calendar` | `/resources` |
| Tutors | Existing Resources form and teaching-guide entries; fixed links independent of async card data. | `/resources#resource-links` and `/resources#resource-guides` | These links remain usable regardless of Resources request state. |

`assets/resources.js` resolves a requested fragment against actual public `data-resource-slug` sections and positions/focuses the section below the navigation. Therefore the two ready category links use established destinations, not guessed anchors. It also preserves the known legacy resource destinations. The tutor card routes through those maintained category entries instead of copying a third-party form URL into a second place or creating a tutor directory/recruitment flow. Existing `RESOURCE_SEEDS` contains the verified registration, reflection and availability form destinations; guide access follows the existing Resources takeover behavior. A destination whose public topic later disappears follows the Resources page's existing unavailable-anchor handling; CP5 does not recreate or publish it.

The system seed currently uses ID/slug pairs `announcements`/`announcements` and `calendar`/`calendar`, initially draft. The controller deliberately does **not** rely on that equality: controlled fixtures use different actual IDs to prove slug-to-ID resolution. The local source/fixtures are checked; the production database's actual ID/slug mapping remains a deployment-preparation check.

The general allocator previously reserved page anchors but omitted these two system slugs. That gap is closed by adding both names to the existing reserved set. General creation now chooses a suffixed alternative even when the system topic is absent from the occupied set. `initialResourceTopics()` still assigns its specified slugs directly; seed IDs, draft states and initialization remain unchanged. Existing records keep their names/slugs/publication state. An empty homepage card never creates a topic or publishes a draft.

## Complete snapshot and projection contract

The controller issues **one `GET /api/resources`** with no topic filter and accepts the complete public envelope:

```text
{
  items:  [{ id, category, topicId, type, title, description, url, sortOrder }],
  topics: [{ id, title, description, slug, sortOrder }],
  guidesTakeover: "legacy" | "complete"
}
```

There is **no public snapshot version/revision**, item version, `status` or media `hidden` field to use for card selection. The server already projects only public items in public topics and may omit unpublished or empty topics. Its file read returns both arrays together; its PostgreSQL read uses the existing repeatable-read read-only transaction. CP5 does not issue separate topic/item reads or one request per card.

`guidesTakeover` is a string enum at this HTTP boundary. The persisted migration marker may legally be `false`; existing server policy converts that into **`"legacy"`**, provided there are no inconsistent migrated guide records. A boolean `false` in the public response itself is not its current type. Missing fields, an unknown enum, an unavailable/503 response, malformed JSON, duplicate IDs/slugs, invalid text/type/order/URL or an orphan item are request failures, never successful empty arrays. After a confirmed `"complete"`, the controller rejects regression to `"legacy"`, matching the existing Resources takeover safeguard. It does not use legacy Guides DOM or seeds to manufacture successful card data.

Validation checks the entire snapshot before either projection. IDs/slugs, uniqueness and topic relationships follow the existing model; all three language strings are required structurally, with English title required and limits of 200 title / 2,000 description Unicode code points. The existing three item types (`external_link`, `email_request`, `text`) and URL rules are retained. The browser adapter's URL-length check was corrected from UTF-16 `.length` to Unicode code points to preserve historical URLs accepted by the store and PostgreSQL `char_length`; a real-model/projection fixture exercises a URL containing 1,100 emoji and rejects values above 2,048 code points.

A legal missing topic or a legal topic with no public items projects to that card's empty state. A duplicate fixed slug or an invalid association is distinguishable as error. Calendar dates remain part of its authored title/description; no date sorting, new field or calendar API is introduced.

## Card states, isolation and withdrawal

| Situation | Result |
| --- | --- |
| Initial request pending | Localized loading/Skeleton with a working `/resources` link; no false empty message. |
| Valid first public item | Show its title and description excerpt, preserve the category heading, and link to the Resources category. |
| Valid public empty | Clear prior dynamic title/summary and item/topic identifiers; show the card-specific empty copy and generic Resources link. |
| Initial failure, invalid snapshot or timeout | Show localized error plus native retry button and Resources link immediately. |
| Background failure after ready | Keep the last confirmed item, link and layout; mark the card stale internally. |
| Background failure after empty | Keep empty and mark stale; no seed or older item is restored. |
| New valid snapshot moves/removes/unpublishes the prior item | Adopt the new first item or empty synchronously. Previous public copy is removed. |
| One card's projection/rendering fails | Only that card enters error, clears its prior dynamic copy/IDs, and keeps retry/basic entry; the other card still accepts its result. |

Last accepted data and the current refresh result are separate. A renderer failure after data acceptance cannot keep the withdrawn item's visible title, and a projection failure before assignment cannot revive older retained data on a later network failure or language repaint. The controlled suite explicitly throws inside one card's text write and, separately, during its selection sort to verify both paths. No product-only testing hook is introduced.

Resources requests, timers, abort controllers and generations are owned by the quick-card controller, independently of Banner. It never writes `data-banner-state`, Banner selection, public media snapshot or carousel controls. The tutor links are static and do not depend on either async card succeeding.

## Refresh timing and actual race guarantees

1. Capture the dedicated card nodes and validate the localized label template. Install listeners, the Resources channel and shared-content subscription before one independent initial read.
2. Use one logical in-flight Resources request. Signals received while it is active set `dirty`; settlement performs one coalesced trailing read. A failed request by itself never starts an endless immediate retry loop.
3. Race the **whole fetch plus response body/JSON read** against 5,000ms. Abort that browser request on deadline and clear its timer. Promise settlement is consumed even if a deliberately non-cooperative transport/body later completes.
4. Gate acceptance by request-object ownership, lifecycle generation, active/suspended state and abort status. An old result cannot render, and an old `finally` cannot clear the next request's owner/timer.
5. An absolute initial deadline of **10,000ms** starts once. Retry, notification and lifecycle return do not extend it. Initial failures reveal error immediately; retries never reset the card to an endless Skeleton. Suspension clears the timer but preserves its original deadline for return.
6. Poll the shared Resources snapshot every **15 seconds only while visible**. Focus, visible return, online, page return and manual retry enter the same request path. Hiding pauses that interval; pagehide closes the channel, unregisters the shared handler, invalidates the lifecycle and aborts the browser request. Resume keeps confirmed data, reconnects once and calibrates. Duplicate initialization does nothing; explicit destroy removes installed listeners/subscriptions.

`ihear-resources` uses the exact string **`"updated"`** as a reread signal. The existing admin notifier creates a separate sender channel object, allowing the controller's receiver to handle same-document as well as cross-document delivery. `iHearLiveContent.register("content", { refresh })` receives the existing structured `ihear-content-updates` protocol and same-page `announce` bridge. There is no existing Resources iframe postMessage publisher to imitate; CP5 does not invent one or reinterpret the media-editor bridge.

The shared revision mechanism remains **10 seconds**, with its existing **3-second CDN TTL**. Its initial value establishes a baseline; it does not replace the controller's initial read. No second revision poller exists. Unlike Banner's file-store path, actual Resources mutation responses call `resourceSaved()` and `revisionAfterMutation("content")`, incrementing the in-memory revision in file mode. The direct Resources signal and 15-second fetch also work when the browser observes an unchanged shared revision: the built tests hold only its revision response constant while performing real Resources API writes. This is a controlled notification-independence check, not a claim that the actual Resources file-store mutation leaves its revision unchanged.

Because Resources exposes no comparable server snapshot version, these protections prevent **late/expired request or lifecycle results** from overwriting the current state. They do not prove a general server-version monotonicity property against a later request served inconsistent or stale data by an external infrastructure layer. Gallery version, operation ID, shared revision strings and client time are not substituted as a Resources version. The existing Resources API `Cache-Control: no-store` and Vercel CDN `no-store` remain unchanged.

## Language, safe text, focus and layout

Fixed headings, loading/empty/error/retry/basic-link copy and tutor copy use the existing content-slot generation and three locales. Dynamic Resources text uses its own `en` / `zhHant` / `zhHans` contract, with English display fallback for an empty chosen language. Rendering resolves the **current** document language when a response arrives; no translation is written back. `lang` on dynamic title/summary identifies the actual displayed language, including fallback.

Summary is taken only from `description`, collapsed to plain-text whitespace, then capped at **160 Unicode code points plus an ellipsis** when necessary. This is a local teaser projection, not a schema limit. Empty description stays empty; URL, email address or generated copy is not substituted. Title and summary use text operations, so HTML/script-like resource text remains literal. CTA is always the category/basic Resources entry, even when the chosen item is an external link or email request. Complete Resources-page item behavior is unchanged.

Initial HTML retains the fixed slots so server/bootstrap language handling works before controller takeover. Once successful, the controller removes `data-i18n` and `data-editable-content` only from its state-dependent title/summary/status/retry/link nodes. Their immutable source definitions remain in the inert label template and are read via `iHearPublishedContent.valueFor`. This prevents generic bootstrap/content application from replacing a ready link or error message with its original loading label. Category headings and static tutor links remain in the normal content flow. A shared content-store refresh can complete after the Resources refresh; the next card repaint/15-second read resolves the current fixed labels from that store.

Refreshes keep card, link and text nodes rather than rebuilding the focus section. Unchanged links and keyboard focus remain in place. When successful retry hides the focused retry button, focus moves to that card's retained Resources link. Error controls are native buttons; category/tutor entries are native links. No extra hidden item links are created.

The CP3/CP4 geometry remains: at least 1024px, 7:3 Banner/cards with 24px gap and the existing 16:9 photo preference / 420px minimum; 768–1023px, Banner above three horizontal cards; under 768px, stacked cards and a 16:9 photo with separate text. Banner empty expands the card row at tablet/desktop widths and keeps a vertical stack on mobile. CP5 does not alter photo crop, Banner reservation or control placement.

Card content reserves 40px: a 20px title line and an 18px summary line with 2px gap; CSS visually clamps each teaser to one line. Cards use compact padding, a 28px icon/header and 28px minimum action row while retaining the inherited responsive minimums. Full resource content is available through the category entry. The Skeleton is static, and the existing reduced-motion rule remains in effect. In no-JavaScript mode the loading content is hidden and authored guidance plus basic links remain usable. Measured ready-card heights are 130px at 320/390/767px, 142px at 768/1023px, 132px at 1024px, and approximately 134.8px at 1280px. All three languages were checked at these seven widths, with no horizontal page overflow and CTA bounds inside each card. This is not a measured whole-page CLS score.

## Executed checks and evidence

Command evidence directory: `output/cp5-home-cards/`. Built acceptance uses `http://localhost:3222`, explicit forced file-store mode and a unique `ihear-cp5-cards-*` directory in the OS temporary directory. Initial OneDrive-backed test directories encountered a real `EPERM` during atomic rename; the final test location avoids that synchronization boundary. Screenshots/results remain in `output/playwright/cp5-home-quick-cards/`. The process clears deployment database/storage variables and uses local test actors for real Resources mutation endpoints; screenshots use an anonymous public context. No production data, authentication policy, translation guard or rate limit is relaxed.

Final application build: **`fkzdNx7j9903nF3Uq_eNI`**. Production-browser engine: **Chromium 151.0.7922.34**. The URL compatibility correction is included in this build; later changes are test/report refinements only.

| Actual command | Result | Exit |
| --- | --- | --- |
| `npm run content:generate` | 321 slots generated | 0 |
| `npm run content:check` | 321 slots / 13 pages checked | 0 |
| `npm run test:api` | 427 passed / 0 failed / 0 skipped | 0 |
| `npm run test:operations` | 47 passed / 0 failed / 0 skipped | 0 |
| `npx --no-install vitest run tests/home-banner-controller.test.mjs tests/home-quick-cards.test.mjs` | 53 passed / 0 failed / 0 skipped: Banner 24, quick cards 29 | 0 |
| `npm run lint` | Full repository passed | 0 |
| `npm run typecheck` | Passed | 0 |
| `npm run build` | Passed, build ID above | 0 |
| `npm run test:home-quick-cards` | 16 passed / 0 failed / 0 skipped, including exact three-language text comparison against the actual public payload | 0 |
| `npm run test:e2e`, then `npx --no-install playwright test` | Initial 86 passed / 1 failed (concurrent generated-asset 404); final entire suite 87 passed / 0 failed / 0 skipped | 1 initially; 0 final |
| `npm run test:home-banner-ssr` with `IHEAR_CP3_EVIDENCE_DIR=output/playwright/cp5-cp3-regression` | 12 passed / 0 failed / 0 skipped | 0 |
| `npm run test:home-banner-controller` with `IHEAR_CP4_EVIDENCE_DIR=output/playwright/cp5-cp4-regression` | 16 passed / 0 failed / 0 skipped | 0 |
| `npm run test:resource-topics-public` | 13 public workflow groups passed / 0 failed / 0 skipped | 0 |
| `node output/cp5-home-cards/preserve.mjs` | 24 migrations, 30 protected files, all 311 starting slots and the original 303-value baseline preserved | 0 |
| `git diff --check` | Passed | 0 |

The named command logs are in the command evidence directory, including `browser.log`, `cp3-regression.log`, `cp4-regression.log` and `resources-public.log`. `preservation.json` records actual hashes and added slot definitions. Formal case names, assertions, dimensions, lifecycle observations and screenshot paths are in `output/playwright/cp5-home-quick-cards/results.json`; CP3 and CP4 regression results are in their separately named directories above. Evidence is not overwritten into prior accepted checkpoint reports.

The controlled suite runs the actual homepage markup and controller in Chromium with deliberately ordered fetch/body responses and clocks. It covers real topic IDs, deterministic selection, legal missing topics, takeover enum/marker mapping, malformed whole snapshots, ready/empty stale behavior, dirty coalescing, body timeout and late completion, the absolute loading deadline across lifecycle cancellation, isolated renderer/projection errors, current-language fallback and safe code-point excerpts, unchanged-revision direct refresh, visibility signals, duplicate initialization and the actual shared revision baseline/10-second behavior. These lifecycle events are controlled simulations, not proof of a real BFCache hit.

The built suite additionally exercises real isolated publish/unpublish/move operations, category anchors and tutor links, independent Banner interaction, mobile/tablet/desktop and breakpoint layouts, keyboard/no-JavaScript entry behavior, and a controlled Resources response held after its snapshot read. The existing 13-group Resources regression separately covers archived/private content and all full-catalog item types.

The initial combined controller regression found an obsolete CP4 expectation: focus correctly moved to the retained announcements-card link, whose CP5 initial destination is now `/resources`, while the old assertion expected `/resources#announcements`. The test now checks both the exact retained card-link identity and the loading destination; final 53-case regression passes. The failed log remains `controller-tests-before-cta-update.log`. The historical Unicode URL issue was found by independent contract review and corrected before final acceptance; it required only the new adapter's length check, not a store/API change.

Browser development attempts are preserved as `browser-attempt*.log` and corresponding results. They exposed fixture mistakes (Banner captions require all languages, the initial Banner seed must be cleared for a two-photo fixture, Resources file mutations really increment revision, and nonempty manual translations must follow the existing English-source confirmation flow). These were fixed in the test setup, without changing production contracts. One return-navigation error did not recur; its precise cause remains undetermined. An independent attempt recorded the OneDrive `EPERM` described above; those two observations are not assumed to have the same cause. The final disposable-directory runs retain the original behavior assertions.

The first existing E2E run overlapped the Resources smoke's asset preparation. Its saved trace records `/get-involved` returning **404 at 2026-10-07T15:46:52.867Z**, while `prepare-public` regenerated the same files. The whole 87-case suite then passed without concurrent regeneration or changes to the affected feature. The original log and trace/screenshot are retained as `e2e-attempt-1.log` and `e2e-attempt-1-artifacts/`.

Representative reviewed screenshots (relative to `output/playwright/cp5-home-quick-cards/`):

- `loading-desktop.png`, `ready-desktop.png`, `empty-desktop.png`, `initial-error-desktop.png`: Skeleton and resolved states preserve the card grid and usable entries.
- `cards-zhTW-320.png`, `cards-en-768.png`, `cards-zhTW-1024.png`: mobile/tablet/desktop, long literal text, English fallback, visible keyboard focus and CTA containment.
- `one-card-error-desktop.png`: announcement rendering failure does not clear calendar or disable Banner.
- `no-js-mobile.png`, `empty-stale-mobile.png`: basic no-JavaScript destinations and confirmed-empty persistence.

The final result lists 19 screenshots and 21 locale/viewport measurements. `renderedLanguages` records exact title/summary and Banner-caption comparisons with the public payload in all three languages; missing translations remain unmodified in the isolated stored document. Visual inspection confirms the intended clamping, separate mobile Banner copy, working focus outlines and no overlapping card controls. Text is deliberately clipped to short teasers; full content remains at the linked category.

## Preservation, limitations and stopping point

All 24 migration raw bytes and runner checksums are protected. Migration 024 remains `2d7bd0f91bcd082abef6035c30a968663d843c4219c97bfe97dc9cd4f8253902`. The existing generator, Banner/media contracts and implementation, shared revision service/TTL, Resources store/public projection, prior checkpoint reports and local `data/resource-links.json` are among the 30 protected files. CP5's allocator addition changes future general slug allocation only. A complete PostgreSQL upgrade rehearsal is unnecessary because no migration or store logic changes; production ID/slug mapping is still unverified.

The prior limitations remain open: a real BFCache restoration has not been demonstrated, actual screen-reader and physical-device testing have not been done, other browser engines are unverified, and production CDN/CSP delivery is not validated locally. Both CP4 regression and CP5 actual away/back attempts reported `pageshow.persisted=false`, with `response-cache-control-no-store` and `response-cache-control-no-store-with-js-network-request` among the recorded reasons. Repeated synthetic events are separate evidence, not a real BFCache hit. Keyboard/DOM semantics automation is not a screen-reader test.

The homepage/public media cache contract remains `private, no-store, max-age=0`, Vercel CDN `no-store`; valid versioned images retain one-year immutable caching. CP3's server deadline only stops waiting for its store read; CP5 browser abort does not cancel that server SQL/file operation. Local exact-policy CSP browser checks, if rerun, do not establish production header delivery. No CSP relaxation is introduced.

Evidence under `output/` is local and Git-ignored; archive it separately when sharing this report. **CP5 is complete and work stops here.** Focus-area integration acceptance, production mapping/cache/CSP checks and deployment preparation remain subsequent work.
