# Resources topics — Checkpoint 1

This checkpoint is schema/model compatibility work only. It does not enable
topic APIs, topic editing, new public rendering, anchors, mailto links or guide
content import. No production migration, commit, push or deployment is included.

## PostgreSQL migration 023

The existing migration runner executes each SQL file and its schema-migrations
record in one transaction under an advisory lock. Do not edit migrations 001–022.
Do not run `db:migrate` against the site's environment during checkpoint review.

`resource_topics` contains:

| Column | Rules/default |
| --- | --- |
| `id` | Primary key, 1–80 ASCII letters/digits/hyphens |
| `title` | Three string locales; nonempty English; each <= 200 characters |
| `description` | Three string locales; each <= 2000 characters; empty by default |
| `slug` | Unique across all statuses, lowercase ASCII segments separated by hyphens, 1–120 characters; immutable after insert |
| `sort_order` | Integer 0–1,000,000; default 0 |
| `status` | `draft / published / archived`; default `draft` |
| `version` | Positive integer; default 1 |
| `created_at`, `updated_at` | Non-null timestamps, default now |
| `created_by`, `updated_by` | Nonempty actor names, <= 320 characters |
| `archived_from_status` | Nullable `draft / published`; captured when archiving |

Row-level security is enabled with no new public policies. The existing trusted
server connection remains responsible for writes. Indexes cover topic status/order
and item topic/status/order. A topic change bumps the existing content revision.
Versions/authorship remain the responsibility of the existing mutation pattern;
this checkpoint does not implement an API or audit-log endpoints.

`resource_links` gains a non-null `topic_id` foreign key with RESTRICT on delete
and update, and non-null `type` defaulting to `external_link`. The URL stays a
non-null string, now defaulting to empty. Its old HTTPS-only CHECK is replaced:

* `external_link`: HTTPS URL shape, nonempty host, no whitespace/backslash or
  authority credentials, <= 2048 characters.
* `email_request` and `text`: URL must be exactly empty. Email destinations and
  subjects are not persisted/inferred here.

Full URL parsing remains in the application validator; the database enforces
the structural boundary. New locale/actor checks reject malformed legacy rows
transactionally rather than silently correcting them. No old text or authorship
is changed to satisfy a constraint.

Any item reference (including an archived item) blocks topic archival. Foreign
keys block physical parent deletion. New/moved references lock the topic and
reject archived parents. Hiding a topic means `status='draft'` and does not change
its items. Topic/item archive triggers remember the previous active status and
clear it on restoration; legacy archived rows without provenance restore to draft
through the model's `restoredResourceStatus` helper (existing item store already
has this fallback). They are not retroactively assigned a guessed prior state.

## Migration and old-program compatibility

Seven stable topics are inserted only if missing: forms, guides, articles,
journal-club, guest-speakers, calendar and announcements. Forms/articles start
published to preserve existing grouping; the other topics are drafts. The guide
title is a draft placeholder, not a replacement for live guide text.

Existing `form`/`article` items map to forms/articles. Only the added reference and
type are populated; titles, descriptions, URLs, ordering, statuses, versions,
timestamps, authors and existing translation states are retained. New topic title
provenance uses the existing translation type `resource`, scope `topic`; only
newly inserted topic IDs receive initial manual states. API support for that
scope remains Checkpoint 2.

Old INSERT/UPSERT statements omit topic/type: the trigger assigns the corresponding
built-in topic and the type default applies. Old updates preserve explicit custom
topics. Changing an old category moves a matching built-in reference to its new
counterpart, but never moves a custom reference. `category` remains intact.

Direct SQL reruns preserve administrator edits, archived states, moved references
and translation locks. A slug collision with a different topic ID fails instead
of associating resources incorrectly. Missing built-in topics are inserted;
existing IDs are never reset. Constraint failure rolls back the complete migration.

Compatibility is for legacy forms/articles while the site is still running the
old application. **Do not activate custom grouping, hide entire topics, or publish
non-link types until the API and public-rendering checkpoints are deployed.**
The old public reader does not yet filter parent topics. This is not a completed
feature rollout or approval to run the production migration.

## Local file mode

Canonical file format: `{ schemaVersion: 2, topics: [...], items: [...] }` in the
same resource-links JSON document. Items include `topicId`, `type`, and existing
translation `states`; topics carry their own states. Extra document metadata is
retained. Migration is pure, clones its input, rejects unknown future schema
versions and validates uniqueness, references, statuses and typed URL rules.

The existing store reads old documents through this normalizer without writing on
read. Its next successful legacy mutation persists the whole document using the
existing queued temporary-file/rename flow. The adapter keeps the current API
projection unchanged and preserves topic data while applying old item operations.

An offline CLI can validate without writing:

```powershell
node --experimental-strip-types scripts/migrate-resource-file.mjs --input <copy-of-resource-links.json>
```

Adding `--output <new-file.json>` writes only to a new destination (`wx`). It never
loads `.env`, connects to a database, selects the real data file implicitly,
rewrites its source, or overwrites a destination. Use copies for review.

Do not run an older file-mode binary against an upgraded JSON file: the older
writer only saves `{items}` and would drop topics. Retain this storage adapter
when rolling back local-mode code. New topic mutations will enforce transition
rules/immutability through the model/store in Checkpoint 2; there is no new CRUD
surface in this checkpoint.

## Reproducible checks

```powershell
npm run test:resource-model
npm run test:resource-schema
npm exec -- vitest run tests/resources-api.test.mjs
npm run lint
npm run typecheck
```

The schema test requires Docker and a locally available `postgres:17-alpine`
image. It intentionally fails if unavailable instead of skipping. It creates a
uniquely named, disposable container with `--network none`, no ports and no host
volumes; no database environment variables are read. It applies the real
migrations 001–022, then tests 023, old writes, constraints, defaults, preservation,
repeated migrations, and failure rollback in a second isolated database. The
container is stopped/removed in teardown.

Model tests are included in `test:api`; Docker schema tests have an explicit
command to avoid making the existing local API suite depend on Docker. Backup
format/restore tooling for the new table and a real-data rehearsal remain gated
work for Checkpoint 6, before any production rollout. Nine-guide content import
must use then-current localized text/layout data, not these placeholder seeds.

STOP after Checkpoint 1 review. No work beyond this checkpoint is authorized yet.

Checkpoint 1 validation on 2026-09-21:

* `npm run test:resource-schema`: PASS, 32 real PostgreSQL tests.
* `npm run test:resource-model`: PASS, 27 model/file tests.
* `npm run test:api`: PASS, 282 tests in 19 files (includes the model suite).
* `npm run lint`: PASS.
* `npm run typecheck`: PASS.
* `git diff --check`: PASS.
* Docker test-container inventory after teardown: empty.

An initial PL/pgSQL CASE parsing error, a test fixture passing fields not accepted
by the legacy parser, and one test lint error were corrected before the passing
runs above. No production database connection or production mutation was used.
