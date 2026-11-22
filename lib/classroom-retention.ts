// Gate B (round 10, 2026-11-22): the owners' preview and apply of the recordings' retention
// (tools/recording-pathway/classroom/retention.mjs). Off unless CLASSROOM_RECORDING_RETENTION_DAYS is
// set: how long recordings are kept is iHear's decision, and nothing is deleted without it. Nothing
// runs by itself: an owner previews, then applies exactly the plan previewed.
// Round 12 (2026-11-22): which recordings a period covers is named, never assumed
// (CLASSROOM_RECORDING_RETENTION_SCOPE: fixed-room, block, one-to-one), so the original one-to-one
// classroom's recordings are never in a plan unless the scope names them; applying needs the owner
// to be named in CLASSROOM_RECORDING_RETENTION_DELETERS, and a permanent deletion its own yes.

import type { ClassroomDrive } from "./classroom-drive";
import type { ClassroomStore } from "./classroom-store";
// @ts-ignore - shared classroom logic, plain JavaScript tested with node --test.
import { applyRetention, mayApplyRetention, readRetentionPlan, RETENTION_BATCH_MAX, retentionPolicy } from "../tools/recording-pathway/classroom/retention.mjs";

const refused = (status: number, code: string, error: string) => ({ status, body: { ok: false, code, error } });
const iso = (ms: number | null) => (ms == null ? null : new Date(ms).toISOString());
const NOT_SET: Record<string, string> = {
  RETENTION_NOT_SET: "No retention period is set for this site: nothing is ever deleted",
  RETENTION_INVALID: "The retention period set for this site is not a whole number of days from 1 to 3650: nothing is deleted",
  RETENTION_MODE_INVALID: "The deletion mode set for this site is neither trash nor remove: nothing is deleted",
  RETENTION_SCOPE_NOT_SET: "The retention period names no kind of recording (fixed-room, block, one-to-one): nothing is deleted",
  RETENTION_SCOPE_INVALID: "The retention scope names a kind of recording that does not exist (only fixed-room, block, one-to-one): nothing is deleted",
  RETENTION_DELETERS_INVALID: "The list of people who may delete recordings holds something that is not an address: nothing is deleted",
};

type Policy = { problem: string | null; days: number | null; mode: string | null; scope: string[]; deleters: string[] };

// Whether the site sets a retention period at all (set but invalid counts, so it is said).
export function retentionConfigured() {
  return (retentionPolicy() as Policy).problem !== "RETENTION_NOT_SET";
}

type PlanItem = { providerFileId: string; lessonId: string | null; kind: string; name: string | null; filedAt: number };
type Plan = { problem: string | null; due: PlanItem[]; kept: { providerFileId: string; reason: string }[]; digest: string | null; days: number | null; mode: string | null; scope: string[]; byKind: Record<string, number>; cutoff: number | null; truncated: boolean };

export async function previewRetention({ store, now, actor = null, limit = RETENTION_BATCH_MAX }: { store: ClassroomStore; now: number; actor?: string | null; limit?: number }) {
  const policy = retentionPolicy() as Policy;
  const plan = (await readRetentionPlan({ store, policy, now, limit })) as Plan;
  if (plan.problem) return refused(409, plan.problem, NOT_SET[plan.problem] ?? "Nothing is deleted");
  return {
    status: 200,
    body: {
      ok: true, days: plan.days, mode: plan.mode, scope: plan.scope, byKind: plan.byKind, cutoff: iso(plan.cutoff), digest: plan.digest,
      // Mode remove deletes for good: the apply must say permanent: true.
      permanent: plan.mode === "remove",
      // Whether the person previewing may apply it (named in CLASSROOM_RECORDING_RETENTION_DELETERS).
      mayApply: mayApplyRetention(policy, actor) as boolean,
      // More are due than one batch holds: apply this one, then preview again.
      truncated: plan.truncated,
      due: plan.due.map((item) => ({ recordingId: item.providerFileId, kind: item.kind, name: item.name, filedAt: iso(item.filedAt) })),
      kept: plan.kept.map((item) => ({ recordingId: item.providerFileId, reason: item.reason })),
    },
  };
}

export async function runRetention({ store, drive, now, actor, confirm, permanent = false, limit = RETENTION_BATCH_MAX }: { store: ClassroomStore; drive: ClassroomDrive; now: number; actor: string; confirm: unknown; permanent?: boolean; limit?: number }) {
  const policy = retentionPolicy() as Policy;
  const result = (await applyRetention({ store, drive, policy, now, actor, confirm, permanent, limit })) as { ok: boolean; code?: string; digest?: string | null; due?: number; mode?: string; days?: number; scope?: string[]; truncated?: boolean; results?: { providerFileId: string; outcome: string; note?: string }[] };
  if (!result.ok) {
    if (result.code === "NOT_A_DELETER") return refused(403, "NOT_A_DELETER", "Only a person the site names in CLASSROOM_RECORDING_RETENTION_DELETERS may delete recordings: nothing is deleted");
    if (result.code === "PERMANENT_NOT_CONFIRMED") return { status: 409, body: { ok: false, code: "PERMANENT_NOT_CONFIRMED", error: "This plan deletes for good (mode remove): confirm it with permanent: true. Nothing is deleted", digest: result.digest ?? null, due: result.due ?? 0 } };
    if (result.code === "PLAN_CHANGED") return { status: 409, body: { ok: false, code: "PLAN_CHANGED", error: "The recordings due changed since the preview: preview again", digest: result.digest ?? null, due: result.due ?? 0 } };
    if (result.code === "NO_DRIVE") return refused(409, "NO_DRIVE", "No Drive is set for this site");
    return refused(409, String(result.code), NOT_SET[String(result.code)] ?? "Nothing is deleted");
  }
  return { status: 200, body: { ok: true, digest: result.digest, mode: result.mode, days: result.days, scope: result.scope ?? [], truncated: result.truncated === true, results: (result.results ?? []).map((entry) => ({ recordingId: entry.providerFileId, outcome: entry.outcome, ...(entry.note ? { note: entry.note } : {}) })) } };
}

// What the activity record says an apply did: every copy deleted, some, or none (a copy whose
// deletion's record could not be written counts as not deleted here; its own answer says so).
const DELETED_OUTCOMES = new Set(["TRASHED", "REMOVED", "ALREADY_IN_TRASH"]);
export function retentionActivityStatus(results: { outcome: string; note?: string }[]) {
  const done = results.filter((entry) => DELETED_OUTCOMES.has(entry.outcome) && entry.note !== "NOT_RECORDED").length;
  if (!results.length || done === 0) return "nothing_deleted";
  return done === results.length ? "deleted" : "partly_deleted";
}
