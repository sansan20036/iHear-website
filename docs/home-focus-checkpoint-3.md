# CP3 — Homepage Focus Layout and Banner SSR

Status: **passed — stopped at CP3**, 2026-10-07. Production-build browser acceptance completed with 12 passed, 0 failed, 0 skipped; exit code 0.

## Baseline and actual request path

Observed HEAD: `fd6a93dd433da347ca4e5d412c25d6f5280fc57f`. The worktree had **24 existing modified/untracked entries**, including accepted CP0/CP1/CP2 work and an untracked TypeScript build-info file. These were retained. The starting status, source snapshots, migration hashes and protected-file hashes are in `output/cp3-home-focus/baseline.json`.

Repository rules, source homepage, preparation script, public route/renderer, language bootstrap, gallery/resource controllers, CP1 projection/types/resolver and [CP1](media-contract-checkpoint-1.md)/[CP2](media-admin-checkpoint-2.md) reports were reviewed. No additional formal media checkpoint plan was found. This checkpoint follows the user's CP3 specification.

`app/route.ts` already declares `dynamic = "force-dynamic"` and calls `servePublicPage(request, "/")`. `scripts/prepare-public.mjs` creates `.private/index.html` from source; this is a template, not a build-time Banner snapshot. Each request now reads current content, metrics and the independently bounded Banner projection. No self-HTTP request or Resources SSR dependency was added. Original introduction, sections, navigation and other anchors remain. The existing `#top` anchor moved to the new first section so the homepage Logo still returns to the actual top.

## Changes in this checkpoint

| Files | Purpose |
| --- | --- |
| `lib/home-banner.ts` | Request-local public snapshot loader, validation/allowlist and one-second deadline. |
| `lib/home-banner-render.ts` | First-photo HTML, text/attribute/JSON escaping, responsive preload, language fallback and state rendering. |
| `lib/public-page.ts` | Start Banner loading alongside existing reads and render its result without turning a Banner failure into page 503. |
| `lib/render-page-content.ts` | Version the updated synchronous content bootstrap. |
| `index.html` | Focus section, three named card containers, fixed-copy/error templates and preserved top navigation; former intro photo becomes lazy. |
| `assets/home-focus.css` | Responsive grid, stable image frame, multilingual text reservation, contrast, empty/error states and mobile initial-menu guard. |
| `assets/content-bootstrap.js` | Apply browser-only language to dynamic Banner text/alt during parsing, retain language-switch behavior and show image-failure alternative. |
| `assets/site.js` | Ten fixed-copy translation entries in each Chinese dictionary. |
| `assets/site-media-bootstrap.js` | Preserve the existing media lookup while suppressing the former hero's high-priority preload when a Banner snapshot is present. |
| `app/admin/media/page.tsx`, `app/admin/admin.css` | Calibrate mobile and simulated-desktop crop previews. |
| `scripts/prepare-public.mjs` | Version and include homepage-only focus CSS after shared CSS; regenerate from sources. |
| `data/content-slots.json`, `docs/content-slot-inventory.md` | Generated through the CP0 workflow: 10 new slots, no changes to the 293 prior semantic values. |
| `tests/home-banner-ssr.test.mjs`, `tests/home-banner-bootstrap.test.mjs` | 57 loader/renderer/public-route/preload contract cases. |
| `tests/home-banner-ssr.smoke.mjs` | Built-server acceptance, real admin API mutations and visual evidence. |
| `package.json` | Add the new contract tests to API regression and the new smoke to `check`. |
| `docs/media-galleries.md`, this report | Current contracts, verification and next-stage boundary. |

The list is relative to the starting worktree, not the complete `git diff HEAD`. CP1/CP2 reports, store/API contracts, resolver, generic controllers and all migrations remain unchanged.

## Snapshot and state contract

The loader reads `listGalleries()` once, selects `home-banner`, and calls the existing public `publicGalleries()` projection. It validates and copies the allowed public fields. That one projected result supplies HTML, JSON and preload; the renderer does not perform a second read. This reuses the CP1 projection, not a new transactional store interface.

The embedded `#ihear-home-banner` JSON has:

```ts
{
  schemaVersion: 1,
  galleryId: 'home-banner',
  state: 'ready' | 'empty' | 'error',
  version: number | null,
  updatedAt: string | null,
  items: HomeBannerItem[]
}
```

Each item retains its public ID, photo kind, `hidden: false`, asset slot, nullable three-language title, caption and public image metadata, including image record version and variants. Hidden records are excluded before resolution and defensively filtered again. Actor, operation/provenance records and internal `storagePath` properties are not copied. Existing public versioned image URLs, including their object reference query parameters, remain intact.

| State | Initial HTML and behavior |
| --- | --- |
| `ready` | At least one valid public photo. Render only the first in saved order; embed all ordered public items for later controller integration. Only that first photo is preloaded. |
| `empty` | A successful empty public read, including all-hidden. Remove Banner content, hide its wrapper and expand the cards; version remains the successful gallery version. |
| `error` | Rejection, deadline or invalid public data. Items are empty and versions null; retain the Banner frame and localized same-site retry link. No underlying exception details are exposed. |

Missing images, unsafe URLs or visible legacy Banner videos produce `error` rather than a misleading empty result. CP2's photo-only write contract is unchanged; a historical unsupported item can still be removed in admin. Empty/error never inserts an item or invokes a `home.hero` fallback directly. `home.hero` can resolve only when a real public item references it, through CP1's existing resolver. CP1's store-level first initialization is unchanged; an administrator-cleared row remains empty.

The **1,000ms deadline limits waiting**, not the lifetime of the underlying operation. The current file/PG store functions expose neither an AbortSignal nor a per-query cancellation handle. Their shared PG client is not terminated. The timer is cleared on settlement; late success/rejection is consumed and cannot replace an already returned error snapshot. Unit tests exercise the exact deadline boundary with a controlled clock and both late outcomes. A slow underlying read can continue using its existing resources until its own completion; no cancellation claim is made.

Retry is a normal relative same-page link with the request pathname/query preserved and escaped. Existing cookie/Accept-Language behavior applies again without JavaScript. Local error tests confirm HTTP 200, original introduction and three cards remain available. Existing content/metrics failure behavior outside Banner was not changed.

## Language, images and safe output

- Server priority remains valid `ihear-lang` cookie (`en`, `zhTW`, `zhCN`), then the existing Accept-Language selection. Query parameters are preserved, not introduced as a new language-priority rule.
- Browser priority remains saved `localStorage['ihear-lang']`, then navigator language. The server does not claim access to localStorage.
- Snapshot JSON precedes the synchronous head bootstrap. The existing MutationObserver applies dynamic title/caption/alt as nodes are parsed, before DOMContentLoaded; it also sets the document language early. Later `ihear:language` events change only displayed language, without refetching or writing translations.
- A blank translation displays English if English exists. If all titles are blank there is no invented title; captions remain separate. Actual fallback text carries `lang="en"`. Snapshot/stored empty fields remain empty.
- Title and caption reserve the greatest required height across all three translations. Each reserved/visible language uses consistent font metrics and letter spacing independent of the document's language, preventing a hidden font/spacing switch from invalidating the reservation. Reserved duplicates are hidden from accessibility APIs.
- The first photo is in initial HTML with `src`, `srcset`, `sizes`, explicit pixel dimensions, `loading="eager"`, `fetchpriority="high"`. Preload uses the same image and responsive sizes. Other Banner items have no rendered image/preload. The intro photo is lazy and its old bootstrap high-priority preload is suppressed when the snapshot exists.
- HTML text, attributes and inline JSON use separate escaping, including script delimiters and U+2028/U+2029. No inline event handlers or CSP relaxation were added.
- Image failure retains geometry, title, caption and localized alt. JavaScript exposes the fixed failure message; without JavaScript the browser's localized native alt remains readable in the reserved image frame.

No `data-media-gallery` or `data-resource-catalog` hook is used inside this section. Existing controllers therefore cannot clear or initialize its SSR DOM. The cards have dedicated announcements/calendar/tutors hooks, fixed headings and normal links to `/resources#announcements`, `/resources#calendar`, `/team#team`. Their content containers stay blank until a later data-integration phase; no false “no announcements/events” message or development explanation is displayed.

## Responsive geometry and admin calibration

The existing container is `min(viewport, 1160px)` wide including 24px padding on each side.

| Viewport | Layout and photo frame |
| --- | --- |
| ≥1024px | 7:3 columns after a 24px gap. Photo width is `(container width − 48 − 24) × 0.7`; its height is `max(width × 9/16, 420px)`. |
| 768–1023px | Full-width Banner above three cards in a row. Photo is 16:9, with no 420px minimum. |
| <768px | Full-width 16:9 photo, separate text underneath, then vertical cards. No 420px minimum. Visible text starts immediately below the photo; reserved extra language space is below it. |
| Empty, ≥768px | Three equal columns across the full container. |
| Empty, <768px | Three vertical cards with no Banner hole. |

The **photo wrapper** explicitly reserves its aspect ratio/minimum height before decoding and always crops with `object-fit: cover; object-position: 50% 50%`. The ready outer wrapper can grow to fit long text; it does not impose an aspect-constrained height that clips copy. Extra text never changes the photo crop. The error frame retains its own preferred ratio/minimum height. Desktop/tablet copy uses the specified full-height gradient; an additional 58% black text surface ensures white text exceeds 4.5:1 even over white image pixels. Mobile uses dark text on white. Reduced-motion settings disable new section animation/transition.

Admin mobile preview remains 16:9. Desktop preview explicitly simulates **1024px viewport → 666.4 × 420px photo frame**, scaled to available admin width. It never applies 420px minimum height to the narrow editor. Preview titles remain below its image; this mode simulates crop geometry, not the entire homepage. No crop coordinates or stored metadata are modified. A portrait's homepage/admin crop ratios and sampled pixels are compared, and stored-image SHA-256 remains unchanged.

## Cache and environment

The actual built localhost responses preserve:

- Homepage and public gallery: `Cache-Control: private, no-store, max-age=0`.
- `Vercel-CDN-Cache-Control: no-store`.
- Valid versioned image: one-year `max-age=31536000, immutable`.

`force-dynamic`, request-local loading and no-store responses mean a subsequent request reads current Banner content without another build. The smoke records BUILD_ID before/after real authenticated admin API uploads, title edits, ordering, hidden changes and clearing; the build ID stays the same while snapshots change.

Browser tests use built Next on loopback port 3218, an independent temporary directory, explicit forced file-store mode, cleared database/storage deployment variables and test-only authentication for mutations. Public screenshots use an anonymous visitor context. This is **file-store acceptance**, not a new PostgreSQL exercise. Final Chromium version: **151.0.7922.34**; build ID: `-gB_ItAepdJPyXbOXchyb`. No production database, deployment or CDN was contacted.

Local Next does not automatically apply `vercel.json`'s CSP header. The smoke records that absence honestly, then tests the exact existing configured policy on the local response via browser interception and observes no added CSP violations. Production CSP/CDN header delivery remains deployment-stage verification; configuration was not weakened.

## Executed checks and evidence

Command logs are under `output/cp3-home-focus/`.

| Actual command | Passed / failed / skipped | Exit | Log |
| --- | --- | --- | --- |
| `npm run content:generate` | 303 slots generated through protected CP0 workflow | 0 | `content-generate.log` |
| `npm run content:check` | 303 slots / 13 pages verified | 0 | `content-check.log` |
| `npm run test:api` | 422 / 0 / 0, 23 files | 0 | `api.log` |
| `npm run test:home-banner-contract` | 57 / 0 / 0, included in API total | 0 | `banner-contract.log` |
| `npm run test:operations` | 47 / 0 / 0 | 0 | `operations.log` |
| `npm run lint` | Passed | 0 | `lint.log` |
| `npm run typecheck` | Passed | 0 | `typecheck.log` |
| `npm run build` | Production compilation, TypeScript and generation passed | 0 | `build.log` |
| `npm run test:e2e` | Final complete rerun 87 / 0 / 0 | 0 | `e2e.log` |
| `npx --no-install playwright test tests/impact-admin.spec.mjs --grep 'current photo lookup\|mobile drawer\|no-JavaScript fallback\|all source pages'` | 4 selected cases / 0 / 0 after later preload/layout refinement | 0 | `e2e-targeted.log` |
| `npm run test:media-admin` | Existing gallery smoke plus CP2 Banner 10 / 0 / 0 | 0 | `media-admin.log` |
| `npm run test:public-pages` | All 13 routes/current content, legacy URLs and cache checks passed, isolated gallery directory | 0 | `public-pages.log` |
| `npm run test:home-banner-ssr` | 12 / 0 / 0, final production build; 35 screenshots | 0 | `browser.log`, browser `results.json` |
| `node output/cp3-home-focus/verify-baseline.mjs` | 24 migrations, 13 protected files and 293 existing slot semantics unchanged | 0 | `preservation.log`, `final-preservation.json` |
| `git diff --check` | Passed | 0 | `diff-check.log` |

The first complete E2E attempt had 86 passes and one failure: the Logo reached the displaced intro instead of scroll position zero. The existing anchor behavior was restored; all 87 then passed. The later four-case selection verifies affected existing preload/navigation/layout behavior; it is not represented as a second full 87-case run.

Browser-test development also found and corrected real 1024px overlap, initial mobile drawer obstruction, maximum-copy clipping and a 24px language-switch shift. Two early harness mistakes were corrected without changing the API: upload fixtures must already be compressed WebP, and whitespace separators at string ends are legitimately trimmed. Attempt logs/results are archived; attempt 1 has an explicitly labeled summary because its original raw log had already been overwritten. CSS injection was used only for diagnosis, never counted as final build acceptance.

### Built-browser scenarios

1. Empty SSR, named cards, no fake empty copy/preload.
2. Real photo upload, matching SSR/snapshot, immutable image and sole high-priority first image.
3. Multiple items, order, edits, hidden/all-hidden, fresh requests without rebuilding.
4. No-JavaScript server languages, fallback and empty titles.
5. Browser-only locale before DOMContentLoaded, first requestAnimationFrame observation, closed menu and unobstructed Banner.
6. Script-like/special-character text, parseable JSON and exact-policy CSP test.
7. 320/390/767/768/1023/1024/1280/1440 layouts; pending-versus-loaded image bounds; maximum title/caption containment and stable language geometry.
8. Image failures with and without JavaScript, readable alternative and retained frame.
9. Invalid isolated Banner data gives local error, original homepage and normal no-JavaScript retry.
10. Generic controller isolation; a real isolated Resources API error does not block homepage; original resource/gallery pages still initialize.
11. Homepage/admin desktop and mobile central crop comparison, original image unchanged.
12. Clearing stays empty on new requests and at all responsive widths, with no reseed.

Evidence lives in `output/playwright/cp3-home-focus/`: structured `results.json`, `ready-*`, `empty-*`, `error-*`, no-JavaScript language/image-error screenshots, `bootstrap-before-domcontentloaded-390.png`, `longest-caption-*`, `homepage-crop-*`, `admin-crop-*`, `special-characters.png` and the portrait fixture. The animation-frame observation is evidence of correct text at the first sampled rendering opportunity while the document is still loading; it is not a claim to have measured an independent compositor first-paint timestamp.

The final 35 screenshots were visually reviewed, including both maximum-copy widths, no-JavaScript and failed-image alternatives, expanded empty cards and desktop/mobile admin crop comparisons. The first sampled animation frame already contained the saved Traditional Chinese title, with `readyState: "loading"` and DOMContentLoaded still false. At 390px, the photo remained **342 × 192.375px** both before and after loading. With maximum 120-character titles and 300-character captions, the outer Banner height remained identical across actual English/Traditional/Simplified switching: **1033px at 320px**, **896.375px at 390px**, **415.9375px at 768px**, and **479.109375px at 1024px**. At 1024px the photo itself remained **666.390625 × 420px**, matching the scaled admin preview of **258 × 162.59375px**. These are measured geometry checks, not a whole-page CLS score. Reserving the longest translation intentionally leaves extra space when another language is shorter.

## Preservation and next boundary

Migration 024 raw SHA-256 and runner checksum remain `2d7bd0f91bcd082abef6035c30a968663d843c4219c97bfe97dc9cd4f8253902`; all 24 migrations are unchanged. Protected CP1/CP2 contracts, resolver/store/API, generic controllers, historical reports and CP0 generator/tests retain their initial hashes. Existing content semantics are unchanged; only ten fixed-copy slots were added. Baseline, final comparisons, logs and screenshots are local artifacts under Git-ignored `output/`; preserve or export that directory when sharing the evidence.

PG store/migrations were not changed, so CP1's nine real PostgreSQL acceptance cases were not repeated. Other browser engines and production CDN/CSP delivery remain unverified. Remaining work: carousel controls/autoplay/touch, local retry, background refresh/notifications/live revisions, rollback-version protection, BFCache handling, quick-card data integration and production CDN/deployment verification. No inactive carousel buttons are shown and none of those later-phase behaviors was introduced. **CP3 is complete; work stops at this checkpoint.**
