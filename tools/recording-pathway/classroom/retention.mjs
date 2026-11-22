// Gate B (round 10, 2026-11-22): how long filed recordings are kept, their deletion, and a record of
// each deletion. Policy neutral and off. How long recordings are kept, who decides, and whether
// anything is deleted at all are iHear's to decide (the Gate B decision list: 保存期限). So:
//   - unset (CLASSROOM_RECORDING_RETENTION_DAYS), nothing is ever due; a value that is not a whole
//     number of days from 1 to 3650 is refused, and nothing is due either (never a guess);
//   - nothing here runs by itself: an owner previews the plan, then applies exactly the plan they
//     saw (its digest); a plan that changed meanwhile is refused, not applied;
//   - only a filed copy (STORED) with a Drive file of its own is ever due; a copy kept for review
//     (QUARANTINED), held or not filed is never touched;
//   - a copy is deleted only when Drive's own record of it names this recording (its appProperties),
//     so a file that is not the recording's copy is never deleted;
//   - each deletion is a fact of its own (server.recording_deleted, one per recording, so a second
//     apply never deletes again), and the attempt is a fact before Drive is asked (who, which plan);
//     a deletion that failed or could not be checked is a fact too and is said, never hidden. A copy
//     Drive does not show, or whose record names another recording, needs a person
//     (server.recording_delete_blocked): it is left out of later plans and listed as such;
//   - a batch holds at most RETENTION_BATCH_MAX copies; the preview says when more are due.
// Mode: "trash" (Drive's trash, recoverable for a while, the default) or "remove" (for good):
// CLASSROOM_RECORDING_RETENTION_MODE, also iHear's decision.
//
// Round 12 (2026-11-22, the user: retention must never reach the original one-to-one classroom's
// recordings by accident; scope, recording kind, policy and who may delete kept apart, so that no
// irreversible deletion happens by mistake):
//   - kind: each recording's kind comes from the server's own record of its lesson, never from a page
//     or a name: "fixed-room" (the lesson's scheduling fact names a fixed room), "block" (a room of a
//     multi-room block) or "one-to-one" (any other lesson the site scheduled);
//   - scope: CLASSROOM_RECORDING_RETENTION_SCOPE names the kinds a period applies to. There is no
//     default: a period with no scope deletes nothing. A one-to-one recording is in a plan only when
//     the scope names "one-to-one" itself;
//   - who may delete: an owner may preview; applying needs the owner's address in
//     CLASSROOM_RECORDING_RETENTION_DELETERS (no one when unset), and a plan in mode "remove"
//     (irreversible) needs that to be confirmed in the apply itself;
//   - the plan's digest covers its period, mode, scope and each copy's kind, so a plan seen under
//     another scope is never applied.
// The state of a recording's retention (deleted, needs a person, in progress, failed) is read from
// its facts by retentionStateOf, the one rule every list and page uses.

import { createHash } from 'node:crypto';

export const RETENTION_DAYS_ENV = 'CLASSROOM_RECORDING_RETENTION_DAYS';
export const RETENTION_MODE_ENV = 'CLASSROOM_RECORDING_RETENTION_MODE';
export const RETENTION_SCOPE_ENV = 'CLASSROOM_RECORDING_RETENTION_SCOPE';
export const RETENTION_DELETERS_ENV = 'CLASSROOM_RECORDING_RETENTION_DELETERS';
export const RECORDING_KINDS = Object.freeze(['block', 'fixed-room', 'one-to-one']);
export const DELETED_EVENT = 'server.recording_deleted';
export const DELETE_FAILED_EVENT = 'server.recording_delete_failed';
export const DELETE_STARTED_EVENT = 'server.recording_delete_started';
export const DELETE_BLOCKED_EVENT = 'server.recording_delete_blocked';
// Every fact a retention attempt writes about one recording (each names its providerFileId).
export const RETENTION_EVENTS = Object.freeze([DELETE_STARTED_EVENT, DELETE_FAILED_EVENT, DELETE_BLOCKED_EVENT, DELETED_EVENT]);
export const RETENTION_BATCH_MAX = 200;
const DAY_MS = 86_400_000;
const MAX_DAYS = 3650;
const EMAIL = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

const toMs = value => (typeof value === 'number' ? value : value == null ? NaN : Date.parse(String(value)));
const listOf = raw => [...new Set(String(raw ?? '').split(',').map(entry => entry.trim().toLowerCase()).filter(Boolean))].sort();
const off = problem => ({ days: null, mode: null, scope: [], deleters: [], problem });

export function retentionPolicy(env = process.env) {
  const raw = env[RETENTION_DAYS_ENV];
  if (raw == null || String(raw).trim() === '') return off('RETENTION_NOT_SET');
  const text = String(raw).trim();
  if (!/^\d{1,4}$/.test(text) || Number(text) < 1 || Number(text) > MAX_DAYS) return off('RETENTION_INVALID');
  const modeRaw = String(env[RETENTION_MODE_ENV] ?? '').trim();
  const mode = modeRaw === '' || modeRaw === 'trash' ? 'trash' : modeRaw === 'remove' ? 'remove' : null;
  if (!mode) return off('RETENTION_MODE_INVALID');
  // Which kinds of recording the period applies to: named, never assumed.
  const scope = listOf(env[RETENTION_SCOPE_ENV]);
  if (!scope.length) return off('RETENTION_SCOPE_NOT_SET');
  if (scope.some(kind => !RECORDING_KINDS.includes(kind))) return off('RETENTION_SCOPE_INVALID');
  // Who may apply a plan: named addresses, none when unset (a preview is still allowed).
  const deleters = listOf(env[RETENTION_DELETERS_ENV]);
  if (deleters.some(entry => !EMAIL.test(entry))) return off('RETENTION_DELETERS_INVALID');
  return { days: Number(text), mode, scope, deleters, problem: null };
}

// Whether this person may apply a plan under this policy (an owner first: the route checks that).
export const mayApplyRetention = (policy, actor) => !policy.problem && policy.deleters.includes(String(actor ?? '').trim().toLowerCase());

// The state of one recording's retention, from its facts (any order), for every list and page:
//   DELETED      the copy was deleted (outcome TRASHED: in Drive's trash, or REMOVED: for good);
//   NEEDS_PERSON Drive did not show the copy, or its record named another recording: a person looks;
//   DELETING     an attempt started and no outcome is recorded yet (cut off, or its record failed);
//   DELETE_FAILED the last attempt failed (Drive refused, or could not be read): the copy is still there;
//   null         no attempt.
export function retentionStateOf(facts = []) {
  // Only the server's own facts count (a page or a vendor never says a copy was deleted).
  const own = facts.filter(event => event?.source === 'server' && RETENTION_EVENTS.includes(event?.type));
  const latest = type => own.filter(event => event.type === type).sort((a, b) => toMs(a.occurredAt) - toMs(b.occurredAt)).at(-1) ?? null;
  const deleted = latest(DELETED_EVENT);
  if (deleted) return { state: 'DELETED', outcome: deleted.outcome === 'REMOVED' ? 'REMOVED' : 'TRASHED', at: toMs(deleted.occurredAt) };
  const blocked = latest(DELETE_BLOCKED_EVENT);
  if (blocked) return { state: 'NEEDS_PERSON', reason: blocked.reason ?? null, at: toMs(blocked.occurredAt) };
  const started = latest(DELETE_STARTED_EVENT), failed = latest(DELETE_FAILED_EVENT);
  // An attempt writes its failure at the same moment it started: a later start is a new attempt.
  if (started && (!failed || toMs(started.occurredAt) > toMs(failed.occurredAt))) return { state: 'DELETING', at: toMs(started.occurredAt) };
  if (failed) return { state: 'DELETE_FAILED', reason: failed.reason ?? null, at: toMs(failed.occurredAt) };
  return { state: null };
}

// The time before which a filed copy is due under this policy (null: nothing is due).
export const retentionCutoff = (policy, now) => (policy.problem || !policy.days ? null : now - policy.days * DAY_MS);

// What is due, from the records and what is already recorded about them. Pure.
export function planRetention({ records, deletedIds = new Set(), blockedIds = new Set(), policy, now, truncated = false }) {
  const cutoff = retentionCutoff(policy, now);
  if (cutoff == null) return { problem: policy.problem ?? 'RETENTION_NOT_SET', due: [], kept: [], digest: null, days: null, mode: null, scope: [], byKind: {}, cutoff: null, truncated: false };
  const scope = [...(policy.scope ?? [])].sort();
  const due = [];
  const kept = [];
  for (const record of records) {
    if (record.status !== 'STORED' || !record.driveFileId) continue;
    if (deletedIds.has(record.providerFileId)) continue;
    const filedAt = toMs(record.filedAt);
    // The store reads only the kinds in scope; this says it again, so a copy of another kind (a
    // one-to-one lesson's, most of all) is never due, even if a store returned it.
    if (!RECORDING_KINDS.includes(record.kind)) { kept.push({ providerFileId: record.providerFileId, reason: 'UNKNOWN_KIND' }); continue; }
    if (!scope.includes(record.kind)) { kept.push({ providerFileId: record.providerFileId, reason: 'OUT_OF_SCOPE' }); continue; }
    if (record.hold) { kept.push({ providerFileId: record.providerFileId, reason: 'HELD' }); continue; }
    // Its deletion is recorded with its lesson's facts: a copy of no lesson is left for a person.
    if (!record.lessonId) { kept.push({ providerFileId: record.providerFileId, reason: 'NO_LESSON' }); continue; }
    if (!Number.isFinite(filedAt)) { kept.push({ providerFileId: record.providerFileId, reason: 'NO_FILED_TIME' }); continue; }
    if (filedAt > cutoff) continue;
    if (blockedIds.has(record.providerFileId) || record.retentionBlocked === true) { kept.push({ providerFileId: record.providerFileId, reason: 'NEEDS_PERSON' }); continue; }
    due.push({ providerFileId: record.providerFileId, lessonId: record.lessonId ?? null, driveFileId: String(record.driveFileId), kind: record.kind, name: record.plannedName ?? null, filedAt });
  }
  due.sort((a, b) => a.filedAt - b.filedAt || a.providerFileId.localeCompare(b.providerFileId));
  const byKind = Object.fromEntries(scope.map(kind => [kind, due.filter(item => item.kind === kind).length]));
  const digest = createHash('sha256')
    .update(JSON.stringify({ days: policy.days, mode: policy.mode, scope, due: due.map(item => [item.providerFileId, item.driveFileId, item.kind]) }))
    .digest('hex').slice(0, 24);
  return { problem: null, due, kept, digest, days: policy.days, mode: policy.mode, scope, byKind, cutoff, truncated };
}

// The plan as the store holds it now: only the kinds in scope, without copies already deleted.
export async function readRetentionPlan({ store, policy, now, limit = RETENTION_BATCH_MAX }) {
  const cutoff = retentionCutoff(policy, now);
  if (cutoff == null || !policy.scope?.length) return planRetention({ records: [], policy: cutoff == null ? policy : off('RETENTION_SCOPE_NOT_SET'), now });
  const records = await store.retentionCandidates(cutoff, limit, policy.scope);
  return planRetention({ records, policy, now, truncated: records.length >= limit });
}

// Applies the plan an owner saw (confirm = its digest), copy by copy; each outcome is said, and one
// copy's trouble never stops the others or hides what was already done. Only a person the site names
// may apply (mayApplyRetention); a plan that deletes for good needs permanent: true as well.
export async function applyRetention({ store, drive, policy, now, actor, confirm, permanent = false, limit = RETENTION_BATCH_MAX }) {
  if (policy.problem) return { ok: false, code: policy.problem };
  if (!mayApplyRetention(policy, actor)) return { ok: false, code: 'NOT_A_DELETER' };
  const plan = await readRetentionPlan({ store, policy, now, limit });
  if (plan.problem) return { ok: false, code: plan.problem };
  if (plan.mode === 'remove' && permanent !== true) return { ok: false, code: 'PERMANENT_NOT_CONFIRMED', digest: plan.digest, due: plan.due.length };
  if (typeof confirm !== 'string' || confirm !== plan.digest) return { ok: false, code: 'PLAN_CHANGED', digest: plan.digest, due: plan.due.length };
  if (!drive || drive.kind === 'none') return { ok: false, code: 'NO_DRIVE' };
  const results = [];
  for (const item of plan.due) {
    const base = { source: 'server', lessonId: item.lessonId, providerFileId: item.providerFileId, driveFileId: item.driveFileId, recordingKind: item.kind, mode: plan.mode, days: plan.days, scope: plan.scope, actor, planDigest: plan.digest, occurredAt: now, receivedAt: now };
    const write = event => store.transaction(tx => tx.insertEvent(event));
    const say = (outcome, extra = {}) => results.push({ providerFileId: item.providerFileId, outcome, ...extra });
    const failed = async (reason, { blocked = false } = {}) => {
      await write({ ...base, type: DELETE_FAILED_EVENT, reason, key: `${DELETE_FAILED_EVENT}:${item.providerFileId}:${now}:${reason}` }).catch(() => false);
      if (blocked) await write({ ...base, type: DELETE_BLOCKED_EVENT, reason, key: `${DELETE_BLOCKED_EVENT}:${item.providerFileId}` }).catch(() => false);
      say(reason);
    };
    try {
      // Who started this deletion, under which plan: written before Drive is asked anything.
      await write({ ...base, type: DELETE_STARTED_EVENT, key: `${DELETE_STARTED_EVENT}:${item.providerFileId}:${plan.digest}` });
    } catch {
      say('NOT_STARTED');
      continue;
    }
    let file;
    try {
      file = await drive.getFile(item.driveFileId);
    } catch {
      await failed('NOT_CHECKED');
      continue;
    }
    // Drive shows no such file: it may be gone, or this access may no longer see it. Never taken as
    // deleted: a person looks (Drive's own trash and sharing).
    if (!file) { await failed('NOT_VISIBLE', { blocked: true }); continue; }
    if (file.appProperties?.providerFileId !== item.providerFileId) { await failed('NOT_THIS_RECORDING', { blocked: true }); continue; }
    let outcome;
    if (file.trashed && plan.mode === 'trash') outcome = 'ALREADY_IN_TRASH';
    else {
      try {
        if (plan.mode === 'remove') await drive.remove(item.driveFileId);
        else await drive.trash(item.driveFileId);
        outcome = plan.mode === 'remove' ? 'REMOVED' : 'TRASHED';
      } catch {
        await failed('DRIVE_REFUSED');
        continue;
      }
    }
    try {
      const recorded = await write({ ...base, type: DELETED_EVENT, outcome, key: `${DELETED_EVENT}:${item.providerFileId}` });
      say(outcome, recorded ? {} : { note: 'ALREADY_RECORDED' });
    } catch {
      // Done in Drive, its record not written: said; the attempt's fact names who did it, and the next
      // apply records it (in the trash, or not visible for a person to confirm).
      say(outcome, { note: 'NOT_RECORDED' });
    }
  }
  return { ok: true, digest: plan.digest, mode: plan.mode, days: plan.days, scope: plan.scope, truncated: plan.truncated, results };
}
