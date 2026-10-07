# CP4 — Homepage Banner Controller and Refresh

Status: **passed — stopped at CP4**, 2026-10-07. Final production-build controller acceptance: **16 passed, 0 failed, 0 skipped; exit 0**. Real BFCache entry was attempted but not achieved; that limitation remains explicitly open below.

## Baseline and scope

Observed HEAD: `fd6a93dd433da347ca4e5d412c25d6f5280fc57f`. The starting worktree contained **37 modified/untracked entries** from CP0–CP3; it was neither assumed clean nor reset. `output/cp4-home-banner/baseline.json` records its exact status, source copies, 24 raw migration hashes/runner checksums, 18 protected files and all 303 current content slots. No additional repository AGENTS or differently named media implementation plan was found. The user's CP4 boundary is used.

Reviewed CP1–CP3 reports, the original homepage requirements, actual SSR renderer/loader, media API/projection/types, gallery controller, live revisions, notification publishers, language bootstrap, asset preparation and built-browser acceptance. CP4 does not change the media store/API, migration, shared live-revision implementation, admin save flow or the quick-card data model. Only local/disposable test data is used; no production database or deployment is involved.

## Files changed relative to this checkpoint's starting worktree

| File | Reason |
| --- | --- |
| `assets/home-banner.js` | Dedicated manual carousel, validated filtered refresh, request/decode/lifecycle generations and lifecycle cleanup. |
| `assets/home-focus.css` | Overlay controls, focus indication, stale retry notice and touch behavior without adding carousel height. |
| `index.html`, `assets/site.js` | Eight localized interaction slots plus references to existing retry/image-error slots; controls remain JavaScript-created. |
| `lib/home-banner-render.ts` | Reserve all public items' three-language text in initial HTML, avoiding a height increase when a longer slide is selected. No snapshot schema changes. |
| `assets/content-bootstrap.js` | Yield dynamic text/image state after controller takeover; after explicit teardown, use the latest accepted snapshot and active ID instead of the old SSR closure. |
| `lib/render-page-content.ts`, `scripts/prepare-public.mjs` | Version the changed assets and inject the controller only on the homepage, after shared live content. |
| `data/content-slots.json`, `docs/content-slot-inventory.md` | CP0-generated catalog with eight additions; all previous values remain unchanged. |
| `tests/home-banner-ssr.test.mjs` | Verify all-slide multilingual reservation while still rendering/preloading only the first public image. |
| `tests/home-banner-ssr.smoke.mjs` | Retain SSR/no-JavaScript checks; adapt the CP3 no-controls assertion to CP4's hidden single-photo controls and allow a separate regression evidence directory. |
| `tests/home-banner-controller.test.mjs` | Controlled response/body/decode ordering against the actual controller and SSR DOM in Chromium. |
| `tests/home-banner-controller.smoke.mjs` | Formal built-server browser acceptance, isolated writes, real gestures and lifecycle evidence. |
| `package.json` | Add controller contract/smoke commands to the existing check workflow. |
| `docs/media-galleries.md`, this report | Current behavior, verification evidence and next-stage boundary. |

This is not an attribution of all `git diff HEAD` changes to CP4. Historical reports and accepted changes remain intact.

## Data, selection and state

The SSR snapshot is already complete: `schemaVersion: 1`, `galleryId: 'home-banner'`, `state`, nullable `version`/`updatedAt` and ordered public `items`. Each item has a stable ID, nullable multilingual title, caption, asset slot and public image metadata including `recordVersion`, URLs and variants. No server/API expansion was necessary. The controller reads `GET /api/media-galleries?gallery_id=home-banner`, validates the existing `{ items: [gallery] }` envelope and allowlists public fields. Missing fields, wrong gallery, duplicate IDs, hidden records in an invalid public response, unsupported videos, unsafe URLs, invalid JSON and non-2xx responses are failures, never successful empty arrays.

The gallery's integer `version` is compared only to the last accepted version for that gallery. `updatedAt`, `operationId`, shared revision strings and image `recordVersion` are not interchangeable with it. Equal gallery versions may legitimately contain changed `home.hero` image metadata, because that image is managed independently. A deleted custom hero can resolve to the contract's fallback image version 0; therefore no invented cross-asset image-version ordering is imposed. Source/version identity still guards image completion.

The actual gallery upload route creates a new operation-derived `assetSlot` and image record with `recordVersion: 1` for each replacement, while preserving the media item ID. The replacement race therefore verifies changed asset/source identity even when both image versions equal 1. A separate controlled case verifies a changed image `recordVersion` with an equal gallery version. Gallery ordering still uses the explicitly returned gallery version, independently of either image behavior.

| Result | Behavior |
| --- | --- |
| Successful ready | Adopt the public set; retain active ID when it still exists. Otherwise select the new first public item. |
| Successful empty | Retain the version and generation, remove image/text/dots, hide Banner and expand the existing cards. |
| Failure after ready | Keep the latest confirmed set, selection and layout; mark stale and offer retry. |
| Failure after empty | Keep empty and its version; do not restore old content or seed. |
| Initial error without success | Preserve the CP3 error frame and native same-page retry link. Plain clicks enhance to local retry; modified clicks retain normal navigation. |
| Lower gallery version | Reject it and retain the newer accepted state, including empty. |
| New replacement image fails | Keep the newly accepted item and image-error alternative; do not return to withdrawn content. |

Accepting changed data synchronously removes withdrawn images, text, reserved copy, control IDs, embedded JSON and obsolete preload references before waiting for replacement decoding. Replacement text/controls refer to the same selected item. The embedded snapshot is updated using safe JSON serialization. Dynamic content uses DOM text/attribute operations, not HTML interpretation.

## Refresh timing and race protection

1. Validate the SSR seed and required localized labels. Preserve the root and initial image, then install listeners/subscriptions.
2. Run one initial calibration independently of shared revision baseline establishment.
3. Use a single request owner. Further signals mark `dirty`; settling the current read starts one coalesced follow-up. A failure alone does not cause immediate endless retries.
4. The browser deadline races the complete `fetch` plus `response.json()` against 5,000ms and aborts its own `AbortController`. Clear that request's timer on settlement. A late result cannot become current; an old finally cannot clear a newer owner.
5. Gate image completion by lifecycle, snapshot-content and selection generations, selected item ID, image source/version identity and actual image-node identity. Completion only adjusts loading/error state; it never inserts an old image.

The shared `iHearLiveContent.register('content', { refresh })` handles structured `ihear-content-updates` messages and same-page `announce`. Its first revision establishes a baseline; CP4 does not treat that as proof that SSR is current. The existing shared poll remains **10 seconds**, and `api/live-revisions` retains **3 seconds CDN TTL**. No second revision poller was introduced.

Media notifications use the existing `ihear-media-galleries` BroadcastChannel payload **`"updated"`**, with no invented gallery/version fields. A distinct sender channel object can notify the controller's receiver even in the same document; cross-document delivery uses the same contract. The existing embedded-editor `ihear:gallery-editor-saved` bridge is accepted only from a same-origin source matching an actual iframe. `ihear-resources` is not treated as Banner data or a version.

CP4 adds a direct gallery refresh every **15 seconds while visible**, so file-store updates still synchronize without a shared revision increase. Focus, online, visibility return, pageshow and retry use the same request entry. Hiding pauses this interval; pagehide additionally closes the channel, unregisters the shared handler, invalidates generations and aborts the browser request. Pageshow resumes from the current accepted state without rereading the original SSR seed. Duplicate script initialization is a no-op. Explicit destroy removes installed listeners/controls and allows reinitialization from the current snapshot/active ID.

Browser abort does not mean the server's underlying SQL/file operation was cancelled. CP3's one-second server wait limit and its lack of underlying store cancellation remain unchanged.

## Interaction, language and geometry

Zero photos use CP3 empty; one has no visible carousel action; two or more have previous/next native buttons, native dot buttons, current-item indication and a localized counter. All paths select by ID with modulo wraparound. There is **no autoplay, autoplay timer or play/pause UI**.

Arrow keys apply only inside the Banner and do not intercept editable controls or links. Tab order is native. Arrow-button focus stays on the same button; keyed dots survive reorder. A refresh restores nearby focus only when the previously focused Banner control is removed/hidden, and never moves focus from an unrelated element. Non-current images have no hidden focusable links. Manual changes use a short polite status message; normal background refreshes do not repeat unchanged content. Control labels, counter, image error/retry states and an existing manual status are localized using the current language, including after a delayed response. The compact stale retry occupies the counter's existing row, with an accessible error description and localized count; arrows/dots remain usable and long copy is not covered.

Only a clear horizontal primary touch/pen gesture (at least 50px, horizontally dominant, under one second) changes a slide. Vertical movement, cancellation, a second pointer or a tap does not. The image uses `touch-action: pan-y pinch-zoom`; resize clears gesture state. No transition-end dependency or automatic motion was added; the existing reduced-motion rule suppresses transitions/animation.

CP3's 7:3 desktop grid, 24px gap, desktop photo minimum 420px, tablet stack and mobile 16:9 photo/separate copy are unchanged. Controls overlay the reserved photo area rather than adding height. SSR now reserves all public slide/locale copy; selection does not rebuild that reservation. Changed data can legitimately change the reservation, and ready/empty changes deliberately change layout. These are separate from ordinary slide/language stability. The admin crop rule remains unchanged. When controls/retry are present, the image-failure message has 96px top padding to clear them. Only the enhanced failed image's broken-image drawing becomes transparent; its alt attribute remains, and the no-JavaScript native alternative is unchanged.

## Executed checks and evidence

Command logs: `output/cp4-home-banner/`. The final browser scenarios use loopback port 3220, explicit forced file-store mode and a separate disposable data directory, clearing deployment database/storage variables. Authenticated mutations use independent local test actors; public screenshots use an anonymous context. No production rate limit or authentication rule was relaxed. CP3 regression runs independently on port 3218; the read-only public route check uses port 3214 with a separately supplied isolated gallery directory.

| Command | Passed / failed / skipped | Exit |
| --- | --- | --- |
| `npm run content:generate` | 311 slots generated | 0 |
| `npm run content:check` | 311 slots / 13 pages verified | 0 |
| `npm run test:api` | 423 / 0 / 0 | 0 |
| `npm run test:operations` | 47 / 0 / 0 | 0 |
| `npm run test:home-banner-contract` | 58 / 0 / 0, included in API count | 0 |
| `npm run test:home-banner-controller-contract` | 24 / 0 / 0 | 0 |
| `npm run lint` | Passed after fixing a test promise-executor lint error | 0 |
| `npm run typecheck` | Passed | 0 |
| `npm run build` | Final production build passed | 0 |
| `npm run test:e2e` | 87 / 0 / 0 | 0 |
| `npm run test:home-banner-ssr` | 12 / 0 / 0 on final build | 0 |
| `npm run test:public-pages` | All 13 public routes, current content, legacy URLs and cache checks passed | 0 |
| `npm run test:home-banner-controller` | 16 / 0 / 0 on final build | 0 |
| `node output/cp4-home-banner/preserve.mjs` | 24 migrations, 18 protected files, all 303 existing slots retained | 0 |
| `git diff --check` | Passed | 0 |

Logs correspond to `content-generate.log`, `content-check.log`, `api.log`, `operations.log`, `ssr-contract.log`, `controller-contract.log`, `lint.log`, `typecheck.log`, `build.log`, `e2e.log`, `ssr-browser.log`, `public-pages.log`, `browser.log`, `preservation.log` and `diff-check.log`. The complete existing 87-case E2E run passed; later teardown and visual refinements were verified by the controller contract suite and final built-browser/SSR runs rather than represented as another full 87-case rerun.

Final browser: **Chromium 151.0.7922.34**. Final build ID: **`S2msV1vv9O_4kM5EqVbVn`**, unchanged throughout the final mutations and acceptance runs. Structured controller results: `output/playwright/cp4-home-banner/results.json`; SSR regression: `output/playwright/cp4-home-banner/cp3-regression/results.json`. Controller evidence contains **13 final screenshots**, separately from archived failure screenshots and the **35 SSR regression screenshots**.

The 5,000ms body deadline's stale/abort result was observed after **5056ms** including browser/test observation latency; controlled-clock cases independently test the 4999/5000ms boundary. After changing slides and languages, measured Banner height was identical for all 3 × 3 combinations at each width: **985px at 320px**, **872.375px at 390px**, **405px at 768px**, **455.109375px at 1024px**, **463.921875px at 1280px**. Stale retry does not change those heights or intersect the title/arrows. In the final failed-image cases, the error text starts at y=176px versus the controls ending at y=159.59px on mobile, and y=192px versus y=175.59px at 1024px. These measurements and both screenshots confirm the reproduced overlap was fixed.

Final controller screenshots were visually inspected: `manual-mobile-reduced-motion.png`, `carousel-long-{320,390,768,1024,1280}.png`, `stale-long-{320,1024}.png`, `replacement-image-failure-{390,1024}.png`, `ssr-calibration-failure-desktop.png`, `empty-desktop.png`, and `initial-error-retry.png`. All are under `output/playwright/cp4-home-banner/`.

The controller contract suite runs the actual script and SSR renderer DOM in Chromium. Fetch response/body, decoder completion and time are controlled deliberately, including a response body that ignores abort so late-result protection is independently exercised. Its lifecycle/visibility cases are event simulations; they do not establish an actual BFCache hit. It also runs the unchanged shared live-content script to verify baseline, 10-second behavior and same-page announce.

The original CP3 smoke first stopped at its obsolete assertion that the Banner contain no button nodes at all. CP4 intentionally creates hidden controls for a single photo. The updated assertion requires no visible actions and independently verifies no controller button in raw SSR HTML. The failed result is archived rather than reported as passing. A first lint attempt found a test-only promise-executor return; it was corrected and the full lint rerun passed.

Early built-browser attempts corrected concrete harness assumptions: new-item ID must equal operation ID; a photo gesture must start outside the control buttons; repeated scenarios need independent test actors to stay within unchanged rate limits; a replacement asset starts at image version 1 rather than incrementing a previous asset's version. A passing run was then strengthened after visual review found stale-message occlusion of maximum copy. The compact retry fix passed. A final added multi-photo image-failure case reproduced localized error text overlapping the control row at both 390px and 1024px; the failure drawing/message treatment was corrected. Failed attempts, intermediate passes and before-fix images are archived under `output/cp4-home-banner/`, not counted as final passes.

### Production-build scenario coverage

1. Preserve the original SSR root/image through takeover and failed initial calibration; no-JavaScript controls stay absent.
2. Real file-store mutations drive 0 → 1 → 3 → 1 → 0 without rebuilding or reseeding.
3. Native buttons/dots, scoped keys, Tab/Shift+Tab, native Chromium touch input through CDP, vertical scrolling, cancelled gestures, two-finger input and reduced motion.
4. Reordering retains active ID/focus; removal picks the new first item and repairs removed-dot/empty-state focus.
5. A response held after its snapshot read receives a burst of notifications and performs exactly one trailing read, never two concurrent requests.
6. Older versions cannot undo a newer ready or confirmed empty state.
7. Delayed JSON body crosses the five-second deadline; browser abort is observed, retry succeeds, and the old body/finally cannot release the new lock.
8. Old selection/image decoders settle after deletion/empty or a later same-item replacement; no old content or error state returns.
9. 503, malformed JSON, missing fields and wrong gallery retain the last success; failed replacement never restores the hidden photo, and failure text clears controls at 390/1024px.
10. Same-window/cross-tab media strings and structured content signals synchronize real file-store changes while its shared revision remains unchanged; resource notifications are ignored.
11. The actual shared script establishes its first baseline without replacing the controller's initial read; browser clock drives its 10-second check and the independent 15-second gallery refresh.
12. Visibility/focus/online and repeated simulated lifecycle returns calibrate once without accumulating handlers or polls.
13. A late response uses the current language; all three slides × three languages keep equal heights at 320/390/768/1024/1280px, including stale retry placement.
14. Real away/back navigation checks `pageshow.persisted` separately from simulated restoration and verifies fresh data on return.
15. Initial SSR error keeps its query-preserving native retry and can recover locally without navigation.
16. A late body from an old lifecycle cannot alter resumed content or unlock its current request.

The CP3 regression retains its 12 scenarios and 35 screenshots under `output/playwright/cp4-home-banner/cp3-regression/`, including no-JavaScript languages/error alternatives, first sampled pre-DOMContentLoaded language, hidden-data exclusion, CSP and admin crop comparisons. Local Next still does not attach Vercel's CSP configuration automatically: the existing exact policy is added by the regression test's response interception, with zero observed violations. This does not verify production header delivery.

## Preservation, limitations and stopping point

All 24 migrations retain their raw bytes and migration checksums. Migration 024 remains `2d7bd0f91bcd082abef6035c30a968663d843c4219c97bfe97dc9cd4f8253902`. All **303** pre-CP4 content slot semantic values are preserved, including the original **293** CP0 baseline values; eight new interaction slots use the unchanged generator. API/store/projection, shared revision implementation/TTL and CP1–CP3 reports are hash-protected. No PostgreSQL migration rerun is required because that logic did not change.

The homepage/public media remain `private, no-store, max-age=0` with Vercel CDN `no-store`; versioned images retain one-year immutable caching. Formal production CDN/CSP delivery, other browser engines and CP3's underlying read cancellation remain unverified. Keyboard/semantic automated tests are not a claim of actual screen-reader testing or physical-device testing. Geometry checks are not a whole-page CLS score.

The **real away/back navigation did not hit BFCache**: `pageshow.persisted=false`, navigation type `back_forward`, with Chromium reasons `masked`, `response-cache-control-no-store` and `response-cache-control-no-store-with-js-network-request`. The returned page did show the latest data. Repeated simulated pagehide/pageshow, subscription cleanup and old-lifecycle completion races passed, but they are not presented as actual BFCache restoration. No cache policy was weakened to manufacture a hit. Genuine BFCache restoration remains unverified in this environment.

Evidence under `output/` is local and Git-ignored; preserve/export it separately when sharing the report. **CP4 is complete and work stops here.** Quick-card data, deployment and any future autoplay proposal remain outside this checkpoint.
