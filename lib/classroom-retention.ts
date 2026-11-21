// Gate B (round 10, 2026-11-22): the owners' preview and apply of the recordings' retention
// (tools/recording-pathway/classroom/retention.mjs). Off unless CLASSROOM_RECORDING_RETENTION_DAYS is
// set: how long recordings are kept is iHear's decision, and nothing is deleted without it. Nothing
// runs by itself: an owner previews, then applies exactly the plan previewed.

import type { ClassroomDrive } from "./classroom-drive";
import type { ClassroomStore } from "./classroom-store";
// @ts-ignore - shared classroom logic, plain JavaScript tested with node --test.
import { applyRetention, readRetentionPlan, retentionPolicy } from "../tools/recording-pathway/classroom/retention.mjs";

const refused = (status: number, code: string, error: string) => ({ status, body: { ok: false, code, error } });
const iso = (ms: number | null) => (ms == null ? null : new Date(ms).toISOString());
const NOT_SET: Record<string, string> = {
  RETENTION_NOT_SET: "No retention period is set for this site: nothing is ever deleted",
  RETENTION_INVALID: "The retention period set for this site is not a whole number of days from 1 to 3650: nothing is deleted",
  RETENTION_MODE_INVALID: "The deletion mode set for this site is neither trash nor remove: nothing is deleted",
};

type PlanItem = { providerFileId: string; lessonId: string | null; name: string | null; filedAt: number };
type Plan = { problem: string | null; due: PlanItem[]; kept: { providerFileId: string; reason: string }[]; digest: string | null; days: number | null; mode: string | null; cutoff: number | null };

export async function previewRetention({ store, now }: { store: ClassroomStore; now: number }) {
  const policy = retentionPolicy();
  const plan = (await readRetentionPlan({ store, policy, now })) as Plan;
  if (plan.problem) return refused(409, plan.problem, NOT_SET[plan.problem] ?? "Nothing is deleted");
  return {
    status: 200,
    body: {
      ok: true, days: plan.days, mode: plan.mode, cutoff: iso(plan.cutoff), digest: plan.digest,
      due: plan.due.map((item) => ({ recordingId: item.providerFileId, name: item.name, filedAt: iso(item.filedAt) })),
      kept: plan.kept,
    },
  };
}

export async function runRetention({ store, drive, now, actor, confirm }: { store: ClassroomStore; drive: ClassroomDrive; now: number; actor: string; confirm: unknown }) {
  const policy = retentionPolicy();
  const result = (await applyRetention({ store, drive, policy, now, actor, confirm })) as { ok: boolean; code?: string; digest?: string | null; due?: number; mode?: string; days?: number; results?: { providerFileId: string; outcome: string }[] };
  if (!result.ok) {
    if (result.code === "PLAN_CHANGED") return { status: 409, body: { ok: false, code: "PLAN_CHANGED", error: "The recordings due changed since the preview: preview again", digest: result.digest ?? null, due: result.due ?? 0 } };
    if (result.code === "NO_DRIVE") return refused(409, "NO_DRIVE", "No Drive is set for this site");
    return refused(409, String(result.code), NOT_SET[String(result.code)] ?? "Nothing is deleted");
  }
  return { status: 200, body: { ok: true, digest: result.digest, mode: result.mode, days: result.days, results: result.results ?? [] } };
}
