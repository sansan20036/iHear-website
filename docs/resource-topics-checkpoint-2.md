# Resources Topic / Item API — Checkpoint 2

Checkpoint 1 is the accepted baseline. This checkpoint adds API and store
operations only. No admin/public HTML, React UI, CSS, anchor navigation, mailto
generation, deployment or production migration is included.

## Endpoints

| Method/path | Behavior |
| --- | --- |
| `GET /api/resources` | Public `{topics, items}` snapshot; retains the existing `items` property |
| `GET /api/resources/[id]` | Public item, or 404 if it or its parent is not public |
| `POST /api/resources` | Create an item; default draft |
| `PATCH /api/resources/[id]` | Partial update; requires current `version`; supports moving via `topicId` |
| `DELETE /api/resources/[id]` | Archive, never permanently delete; requires `version` |
| `POST /api/resources/[id]/restore` | Restore the previous active status, or draft when unknown; requires `version` |
| `GET /api/resource-topics` | Public `{topics}`; omits empty topics |
| `GET /api/resource-topics/[id]` | Public topic, or 404 when hidden/archived/empty |
| `POST /api/resource-topics` | Create a topic and allocate its immutable slug; default draft |
| `PATCH /api/resource-topics/[id]` | Partial update; requires `version`; cannot change slug |
| `DELETE /api/resource-topics/[id]` | Archive only if no items reference it, including archived items |
| `POST /api/resource-topics/[id]/restore` | Restore previous status or draft; requires `version` |

Collection reads accept `?admin=1` for active records or
`?includeArchived=true` for archived records, both requiring an administrator.
Single reads with either flag require an administrator and may return any status.
`GET /api/resources?topicId=<id>` filters its snapshot to one topic; invalid IDs
are rejected, while a nonexistent or nonpublic topic returns an empty public list.

All mutation endpoints use existing owner/editor authorization, same-origin
validation and administrator mutation limits. Anonymous, ordinary signed-in and
disabled-admin accounts cannot manage resources. A client-supplied `isAdmin`,
actor, ID or initial version does not grant access or control stored authorship.

Mutation responses are `{ok, item, revision}` or `{ok, topic, revision}`.
They log `resource.created/updated/archived/restored` or
`resource.topic.created/updated/archived/restored` under existing activity type
`resource`, and return the existing content revision. Responses use `no-store`.

## Inputs and compatibility

Topic input: `title`, optional `description`, `sortOrder`, `status`.
Localized text has `en`, `zhHant`, `zhHans` string fields; English title is
required (200 characters per locale). Description defaults to three empty strings
(2000 characters per locale), order to 0, and status to draft. Missing Chinese is
stored as empty, not copied from English. Partial PATCH retains omitted fields.

Item input adds explicit `topicId`, `type`, and `url`:

* `external_link`: a complete HTTPS URL without credentials, whitespace or
  backslashes; validate with URL parsing, normalize, then enforce the 2048 limit.
* `email_request` / `text`: URL must be empty. Switching to these types clears
  the old URL if the request omits `url`; supplying a nonempty URL is rejected.
* Switching back to external_link requires a valid URL. Blank URLs never cause
  the type to be inferred as email/text.

For existing clients only, omitted type defaults to external_link on creation;
omitted category defaults to form. Omitted topic maps form/article to the built-in
forms/articles topic. Updates preserve omitted type/topic. A category change from
its matching built-in topic follows the new built-in topic, including round-trip
payloads carrying the old reference; a custom topic is preserved. New clients
should manage grouping through `topicId` and omit the legacy `category` field.

Only `draft` and `published` are accepted in normal create/update. Hide is a
transition to draft; archive/restore use their dedicated endpoints. Hiding a
topic does not change children's status, versions, ordering, URLs or translations.
Archived records must be restored before editing/moving. Item movement does not
require translating unchanged text. Topic archival is blocked even if all its
children are drafts or already archived; restore and move those items first.

## Slug, concurrency, visibility and translations

Slugs are generated from English names using lowercase ASCII/hyphen segments,
diacritic normalization and a 120-character limit. An empty result becomes
`topic-<uuid>`. Duplicates get `-2`, `-3`, etc., with suffix space reserved within
the limit. All stored slugs, including archived topics, and existing page IDs
are reserved. Clients cannot select a creation slug or rename an existing slug.

PostgreSQL serializes slug allocation with a transaction advisory lock. Item/topic
updates lock rows and check version inside the transaction, independently of the
route's early check. Item assignment locks the destination topic, serializing it
against archival. Content and translation states commit together. File mode uses
the same canonical document and one shared mutation queue plus atomic rename.

Public data requires both topic and item to be published. Empty topics are
omitted; private IDs return 404 on public single reads. Public projection excludes
versions, status, authors, timestamps and translation provenance. PostgreSQL reads
the topic/item arrays in one read-only repeatable-read transaction; file mode uses
one document read. Knowing an ID or being signed in does not bypass public filters.

Topic preview receipts use `{type:"resource",scope:"topic",id,version}`; items
retain scope `""`. Both use the existing translation-preview API. Unknown resource
scopes are rejected. File-state reads now honor scope, so item/topic provenance
cannot overlap. English changes with retained Chinese require a fresh preview;
unchanged manual Chinese stays protected. Version-bound or cross-scope receipts
cannot be reused. State-only edits do not retranslate or rewrite translation locks.

## Errors

* 400: invalid body, ID, type, status, URL, order/version, immutable slug, permanent
  deletion request, or missing destination topic (`RESOURCE_TOPIC_NOT_FOUND`).
* 403: administrator or same-origin checks fail.
* 404: missing records; public hidden/empty records.
* 409 `RESOURCE_VERSION_CONFLICT`: stale version, including concurrent writes.
* 409 `RESOURCE_TOPIC_NOT_EMPTY`: parent still has references.
* 409 `RESOURCE_TOPIC_ARCHIVED` / `RESOURCE_ARCHIVED`: restore before use/edit.
* 409 `RESOURCE_STATUS_CONFLICT`: archive/restore from the wrong state.
* 409 `TRANSLATION_PREVIEW_REQUIRED`: stale, invalid or mismatched receipt.
* 429: existing mutation limits, retaining Retry-After.
* 503 `RESOURCE_SCHEMA_NOT_READY`: required migration has not been installed.

Database constraint errors are translated into generic API errors without exposing
SQL or connection details. As before, activity logging and revision lookup follow
the content transaction; this checkpoint does not introduce an audit outbox.

## Verification and rollout boundary

The shared API contract is run against both temporary file storage and real,
disposable PostgreSQL 17. PostgreSQL test credentials/port are generated in the
test, bind only to 127.0.0.1, and never load `.env.local`. Tests use the real route
handlers, authorization resolver, validation, store and translation workflow;
the session provider, admin-account lookup, rate-limit decision, activity logger
and revision response are stubbed to exercise allowed/denied cases predictably.
PostgreSQL tests additionally inject a failed translation write to verify rollback
and race an item move against topic archival.

Final validation on 2026-09-22:

| Command | Result |
| --- | --- |
| `npm run test:api` | PASS — 316 tests, 20 files; includes 34 Topic/Item file-mode contract cases |
| `npm run test:resource-api-postgres` | PASS — the same 34 cases plus rollback and parent/child race tests (36 total) |
| `npm run lint` | PASS |
| `npm run typecheck` | PASS |
| `git diff --check` | PASS |

The initial typecheck found an unknown-value narrowing issue in URL normalization;
it was fixed. The Checkpoint 1 assertion that the store omitted `topicId` was
updated to assert the intentionally expanded Checkpoint 2 contract. Review also
identified and fixed legacy category round-trip parity between file/PostgreSQL;
the shared contract now tests it. Final runs above pass after these changes.

Reproducible commands:

```powershell
npm exec -- vitest run tests/resource-topic-api.test.mjs tests/resources-api.test.mjs tests/resource-topic-model.test.mjs
npm run test:api
npm run test:resource-api-postgres
npm run lint
npm run typecheck
git diff --check
```

No new schema migration is needed beyond accepted migration 023. New APIs require
023; do not deploy this checkpoint by itself. The old public UI still only renders
legacy form/article links, and the existing admin UI has not gained topic controls.
Backup/restore expansion and production-copy rehearsal remain gated later work.
No permanent deletion or guide-content migration is performed here.

## Pre-Checkpoint 3 review follow-up

Added eight shared API contract cases, executed against both storage modes:

* Topic and Item single reads for draft and archived records: anonymous public
  reads return 404; anonymous admin reads return 403. Verified owners and enabled
  editors can read either state using `?admin=1` or `?includeArchived=true`, then
  edit a draft or restore an archived record using its returned version. A signed-in
  administrator calling the public URL without a flag still gets public filtering.
* Topic and Item each preserve both archive origins: published restores to published,
  and draft restores to draft. Tests verify the version increments, removal of archive
  provenance after restore, and the persisted record, not just the response.

Follow-up verification (test and documentation changes only):

| Command | Result |
| --- | --- |
| `npm exec -- vitest run tests/resource-topic-api.test.mjs` | PASS — 42 tests |
| `npm run test:resource-api-postgres` | PASS — 44 tests against disposable PostgreSQL |

These extend the earlier 34 shared cases by eight; no runtime or schema change was
needed. No production data was accessed or changed. Checkpoint 3 remains unstarted.

STOP. Wait for explicit acceptance before Checkpoint 3.
