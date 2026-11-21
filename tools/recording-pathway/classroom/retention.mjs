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
//     apply never deletes again); a deletion that failed or could not be checked is a fact too and
//     is said, never hidden; the next apply tries it again.
// Mode: "trash" (Drive's trash, recoverable for a while, the default) or "remove" (for good):
// CLASSROOM_RECORDING_RETENTION_MODE, also iHear's decision.

import { createHash } from 'node:crypto';

export const RETENTION_DAYS_ENV = 'CLASSROOM_RECORDING_RETENTION_DAYS';
export const RETENTION_MODE_ENV = 'CLASSROOM_RECORDING_RETENTION_MODE';
export const DELETED_EVENT = 'server.recording_deleted';
export const DELETE_FAILED_EVENT = 'server.recording_delete_failed';
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

// What is due, from the records and the deletions already recorded. Pure.
export function planRetention({ records, deletedIds = new Set(), policy, now }) {
  const cutoff = retentionCutoff(policy, now);
  if (cutoff == null) return { problem: policy.problem ?? 'RETENTION_NOT_SET', due: [], kept: [], digest: null, days: null, mode: null, cutoff: null };
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
    due.push({ providerFileId: record.providerFileId, lessonId: record.lessonId ?? null, driveFileId: String(record.driveFileId), name: record.plannedName ?? null, filedAt });
  }
  due.sort((a, b) => a.filedAt - b.filedAt || a.providerFileId.localeCompare(b.providerFileId));
  const digest = createHash('sha256')
    .update(JSON.stringify({ days: policy.days, mode: policy.mode, due: due.map(item => [item.providerFileId, item.driveFileId]) }))
    .digest('hex').slice(0, 24);
  return { problem: null, due, kept, digest, days: policy.days, mode: policy.mode, cutoff };
}

// The plan as the store holds it now: filed copies before the cutoff and the deletions recorded.
export async function readRetentionPlan({ store, policy, now, limit = RETENTION_BATCH_MAX }) {
  const cutoff = retentionCutoff(policy, now);
  if (cutoff == null) return planRetention({ records: [], policy, now });
  const records = await store.storedRecordingsFiledBefore(cutoff, limit);
  const lessonIds = [...new Set(records.map(record => record.lessonId).filter(Boolean).map(String))];
  const facts = lessonIds.length ? await store.eventsFor(lessonIds) : [];
  const deletedIds = new Set(facts.filter(event => event.source === 'server' && event.type === DELETED_EVENT).map(event => String(event.providerFileId)));
  return planRetention({ records, deletedIds, policy, now });
}

// Applies the plan an owner saw (confirm = its digest), copy by copy; each outcome is said.
export async function applyRetention({ store, drive, policy, now, actor, confirm, limit = RETENTION_BATCH_MAX }) {
  const plan = await readRetentionPlan({ store, policy, now, limit });
  if (plan.problem) return { ok: false, code: plan.problem };
  if (typeof confirm !== 'string' || confirm !== plan.digest) return { ok: false, code: 'PLAN_CHANGED', digest: plan.digest, due: plan.due.length };
  if (!drive || drive.kind === 'none') return { ok: false, code: 'NO_DRIVE' };
  const results = [];
  for (const item of plan.due) {
    const base = { source: 'server', lessonId: item.lessonId, providerFileId: item.providerFileId, driveFileId: item.driveFileId, mode: plan.mode, days: plan.days, actor, planDigest: plan.digest, occurredAt: now, receivedAt: now };
    const failed = async reason => {
      await store.transaction(tx => tx.insertEvent({ ...base, type: DELETE_FAILED_EVENT, reason, key: `${DELETE_FAILED_EVENT}:${item.providerFileId}:${now}:${reason}` })).catch(() => false);
      results.push({ providerFileId: item.providerFileId, outcome: reason });
    };
    let file;
    try {
      file = await drive.getFile(item.driveFileId);
    } catch {
      await failed('NOT_CHECKED');
      continue;
    }
    // The copy is not there (deleted by hand, or another apply): nothing to delete; said as such.
    if (!file || (file.trashed && plan.mode === 'trash')) {
      const recorded = await store.transaction(tx => tx.insertEvent({ ...base, type: DELETED_EVENT, outcome: file ? 'ALREADY_IN_TRASH' : 'ALREADY_GONE', key: `${DELETED_EVENT}:${item.providerFileId}` }));
      results.push({ providerFileId: item.providerFileId, outcome: recorded ? (file ? 'ALREADY_IN_TRASH' : 'ALREADY_GONE') : 'ALREADY_RECORDED' });
      continue;
    }
    if (file.appProperties?.providerFileId !== item.providerFileId) {
      await failed('NOT_THIS_RECORDING');
      continue;
    }
    try {
      if (plan.mode === 'remove') await drive.remove(item.driveFileId);
      else await drive.trash(item.driveFileId);
    } catch {
      await failed('DRIVE_REFUSED');
      continue;
    }
    const recorded = await store.transaction(tx => tx.insertEvent({ ...base, type: DELETED_EVENT, outcome: plan.mode === 'remove' ? 'REMOVED' : 'TRASHED', key: `${DELETED_EVENT}:${item.providerFileId}` }));
    results.push({ providerFileId: item.providerFileId, outcome: plan.mode === 'remove' ? 'REMOVED' : 'TRASHED', ...(recorded ? {} : { note: 'ALREADY_RECORDED' }) });
  }
  return { ok: true, digest: plan.digest, mode: plan.mode, days: plan.days, results };
}
