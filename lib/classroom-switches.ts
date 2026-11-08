// Two classroom switches, both OFF unless set, so the live site and the round-1 trial server
// (tools/classroom-trial, which records nothing) keep their behaviour. Only the local recording
// test (tools/classroom-recording-test) turns the first one on.

// The tutor's page reports the id of the Zoom session it joined (Video SDK getSessionInfo), and
// the server confirms the id with Zoom before using it. Without webhooks this is how the server
// learns which session to start recording in and whose recordings to collect.
export const sessionReportsEnabled = () => process.env.CLASSROOM_SESSION_REPORTS === "verify";

// Deleting the vendor's copy of a recording once P1 has stored and checked it. Off: the vendor
// keeps its copy until its own automatic deletion, and each filing records that its copy was
// kept. It stays off until the retention decisions are made and a real recording has shown that
// the vendor's sizes are byte counts.
export const vendorDeletionEnabled = () => process.env.CLASSROOM_VENDOR_DELETION === "on";

// P3-Multi (2026-11-09): whether a block's teaching rooms may be recorded at all. Off: every block
// is Classroom Only (the Lobby never records in any case). On only in local synthetic tests until
// the real Zoom checks pass and iHear approves recording in blocks; even then each block starts
// Classroom Only and an owner switches it, which re-checks everything first (18.6).
export const multiRecordingEnabled = () => process.env.CLASSROOM_MULTI_RECORDING === "on";
