import { afterAll, describe, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Round 18d (the fourth real-Zoom sitting, 2026-11-27): TEST-R24 was never recorded. The test
// database showed why: the lesson was made with the codes TEST-T4 and TEST-S4, while consent was set
// for TEST-T24 and TEST-S24, so no consent reached it and its only decision stayed the one at
// scheduling (CONSENT_MISSING). TEST-R25, made with TEST-T24 and TEST-S24, was recorded and filed.
// These checks hold the rule that was in doubt: consent set AFTER a lesson is scheduled reaches it
// (server.consent_changed) and the next tick decides again; consent for other codes changes nothing.
// File store, synthetic provider, synthetic consent; nothing is sent anywhere.
const directory = await mkdtemp(path.join(os.tmpdir(), "ihear-consent-recheck-"));
vi.stubEnv("IHEAR_FORCE_FILE_STORE", "1");
vi.stubEnv("IHEAR_TEST_DATA_DIR", directory);
vi.stubEnv("CLASSROOM_PROVIDER", "synthetic");
vi.stubEnv("CLASSROOM_SYNTHETIC_SECRET", "consent-recheck-token-test-only");
vi.stubEnv("CLASSROOM_DRIVE", "local");
vi.stubEnv("VERCEL_ENV", "");
const { classroomStore } = await import("../lib/classroom-store");
const { classroomProvider } = await import("../lib/classroom-provider");
const { classroomDrive } = await import("../lib/classroom-drive");
const service = await import("../lib/classroom-service");

afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const store = classroomStore();
const provider = classroomProvider();
const drive = classroomDrive();
const lessonByCode = async (code, now) => (await store.listLessons({ from: now - DAY, to: now + DAY })).find((entry) => entry.code === code);

describe("consent set after a lesson is scheduled", () => {
  test("CONSENT-1: the tutor's notice and the student's consent reach the lesson (server.consent_changed), and the next tick decides again: allowed", async () => {
    const now = Date.parse("2026-12-01T15:00:00Z");
    await service.createClassroomLesson({ store, actor: "owner@example.test", now: now - 5 * MIN, input: { code: "TEST-CR1", date: "2026-12-01", time: "10:10", timeZone: "America/New_York", minutes: 30, tutorCode: "TEST-CRT", tutorEmail: "t@example.test", studentCode: "TEST-CRS" } });
    const lesson = await lessonByCode("TEST-CR1", now);
    expect(lesson).toBeTruthy();
    // Decided before any consent: not allowed.
    await service.runClassroomTick({ store, provider, drive, now: now - 4 * MIN, lessonIds: [lesson.id] });
    expect(service.recordingDecision(await store.eventsFor([lesson.id]))).toMatchObject({ decided: true, allowed: false });
    // The owner is told which lessons each one reached (round 18d).
    expect(await service.setSyntheticConsent({ store, personCode: "TEST-CRT", role: "tutor", status: "granted", actor: "owner@example.test", now })).toEqual({ lessons: ["TEST-CR1"] });
    expect(await service.setSyntheticConsent({ store, personCode: "TEST-CRS", role: "student", status: "granted", actor: "owner@example.test", now: now + 1000 })).toEqual({ lessons: ["TEST-CR1"] });
    expect((await store.eventsFor([lesson.id])).filter((event) => event.type === "server.consent_changed")).toHaveLength(2);
    await service.runClassroomTick({ store, provider, drive, now: now + 2 * MIN, lessonIds: [lesson.id] });
    expect(service.recordingDecision(await store.eventsFor([lesson.id]))).toMatchObject({ decided: true, allowed: true });
  });

  test("CONSENT-2: consent for other codes (tonight's TEST-R24: made with TEST-T4/TEST-S4, consent set for TEST-T24/TEST-S24) does not reach the lesson; it stays not allowed", async () => {
    const now = Date.parse("2026-12-02T15:00:00Z");
    await service.createClassroomLesson({ store, actor: "owner@example.test", now: now - 5 * MIN, input: { code: "TEST-CR2", date: "2026-12-02", time: "10:10", timeZone: "America/New_York", minutes: 30, tutorCode: "TEST-T4", tutorEmail: "t@example.test", studentCode: "TEST-S4" } });
    const lesson = await lessonByCode("TEST-CR2", now);
    await service.runClassroomTick({ store, provider, drive, now: now - 4 * MIN, lessonIds: [lesson.id] });
    // Reaching no lesson is said as such: the page warns of a mistyped code (round 18d).
    expect(await service.setSyntheticConsent({ store, personCode: "TEST-T24", role: "tutor", status: "granted", actor: "owner@example.test", now })).toEqual({ lessons: [] });
    expect(await service.setSyntheticConsent({ store, personCode: "TEST-S24", role: "student", status: "granted", actor: "owner@example.test", now: now + 1000 })).toEqual({ lessons: [] });
    expect((await store.eventsFor([lesson.id])).filter((event) => event.type === "server.consent_changed")).toHaveLength(0);
    await service.runClassroomTick({ store, provider, drive, now: now + 2 * MIN, lessonIds: [lesson.id] });
    expect(service.recordingDecision(await store.eventsFor([lesson.id]))).toMatchObject({ decided: true, allowed: false });
  });
});
