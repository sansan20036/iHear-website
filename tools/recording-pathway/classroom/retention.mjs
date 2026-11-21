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

import { createHash } from 'node:crypto';

export const RETENTION_DAYS_ENV = 'CLASSROOM_RECORDING_RETENTION_DAYS';
export const RETENTION_MODE_ENV = 'CLASSROOM_RECORDING_RETENTION_MODE';
export const DELETED_EVENT = 'server.recording_deleted';
export const DELETE_FAILED_EVENT = 'server.recording_delete_failed';
export const DELETE_STARTED_EVENT = 'server.recording_delete_started';
export const DELETE_BLOCKED_EVENT = 'server.recording_delete_blocked';
export const RETENTION_BATCH_MAX = 200;
const DAY_MS = 86_400_000;
const MAX_DAYS = 3650;

const toMs = value => (typeof value === 'number' ? value : value == null ? NaN : Date.parse(String(value)));

export function retentionPolicy(env = process.env) {
  const raw = env[RETENTION_DAYS_ENV];
  if (raw == null || String(raw).trim() === '') return { days: null, mode: null, problem: 'RETENTION_NOT_SET' };
  const text = String(raw).trim();
  if (!/^\d{1,4}$/.test(text) || Number(text) < 1 || Number(text) > MAX_DAYS) return { days: null, mode: null, problem: 'RETENTION_INVALID' };
  const modeRaw = String(env[RETENTION_MODE_ENV] ?? '').trim();
  const mode = modeRaw === '' || modeRaw === 'trash' ? 'trash' : modeRaw === 'remove' ? 'remove' : null;
  if (!mode) return { days: null, mode: null, problem: 'RETENTION_MODE_INVALID' };
  return { days: Number(text), mode, problem: null };
}

// The time before which a filed copy is due under this policy (null: nothing is due).
export const retentionCutoff = (policy, now) => (policy.problem || !policy.days ? null : now - policy.days * DAY_MS);

// What is due, from the records and what is already recorded about them. Pure.
export function planRetention({ records, deletedIds = new Set(), blockedIds = new Set(), policy, now, truncated = false }) {
  const cutoff = retentionCutoff(policy, now);
  if (cutoff == null) return { problem: policy.problem ?? 'RETENTION_NOT_SET', due: [], kept: [], digest: null, days: null, mode: null, cutoff: null, truncated: false };
  const due = [];
  const kept = [];
  for (const record of records) {
    if (record.status !== 'STORED' || !record.driveFileId) continue;
    if (deletedIds.has(record.providerFileId)) continue;
    const filedAt = toMs(record.filedAt);
    if (record.hold) { kept.push({ providerFileId: record.providerFileId, reason: 'HELD' }); continue; }
    // Its deletion is recorded with its lesson's facts: a copy of no lesson is left for a person.
    if (!record.lessonId) { kept.push({ providerFileId: record.providerFileId, reason: 'NO_LESSON' }); continue; }
    if (!Number.isFinite(filedAt)) { kept.push({ providerFileId: record.providerFileId, reason: 'NO_FILED_TIME' }); continue; }
    if (filedAt > cutoff) continue;
    if (blockedIds.has(record.providerFileId) || record.retentionBlocked === true) { kept.push({ providerFileId: record.providerFileId, reason: 'NEEDS_PERSON' }); continue; }
    due.push({ providerFileId: record.providerFileId, lessonId: record.lessonId ?? null, driveFileId: String(record.driveFileId), name: record.plannedName ?? null, filedAt });
  }
  due.sort((a, b) => a.filedAt - b.filedAt || a.providerFileId.localeCompare(b.providerFileId));
  const digest = createHash('sha256')
    .update(JSON.stringify({ days: policy.days, mode: policy.mode, due: due.map(item => [item.providerFileId, item.driveFileId]) }))
    .digest('hex').slice(0, 24);
  return { problem: null, due, kept, digest, days: policy.days, mode: policy.mode, cutoff, truncated };
}

// The plan as the store holds it now (the store leaves out copies already deleted).
export async function readRetentionPlan({ store, policy, now, limit = RETENTION_BATCH_MAX }) {
  const cutoff = retentionCutoff(policy, now);
  if (cutoff == null) return planRetention({ records: [], policy, now });
  const records = await store.retentionCandidates(cutoff, limit);
  return planRetention({ records, policy, now, truncated: records.length >= limit });
}

// Applies the plan an owner saw (confirm = its digest), copy by copy; each outcome is said, and one
// copy's trouble never stops the others or hides what was already done.
export async function applyRetention({ store, drive, policy, now, actor, confirm, limit = RETENTION_BATCH_MAX }) {
  const plan = await readRetentionPlan({ store, policy, now, limit });
  if (plan.problem) return { ok: false, code: plan.problem };
  if (typeof confirm !== 'string' || confirm !== plan.digest) return { ok: false, code: 'PLAN_CHANGED', digest: plan.digest, due: plan.due.length };
  if (!drive || drive.kind === 'none') return { ok: false, code: 'NO_DRIVE' };
  const results = [];
  for (const item of plan.due) {
    const base = { source: 'server', lessonId: item.lessonId, providerFileId: item.providerFileId, driveFileId: item.driveFileId, mode: plan.mode, days: plan.days, actor, planDigest: plan.digest, occurredAt: now, receivedAt: now };
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
  return { ok: true, digest: plan.digest, mode: plan.mode, days: plan.days, truncated: plan.truncated, results };
}
