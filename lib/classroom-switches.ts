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
