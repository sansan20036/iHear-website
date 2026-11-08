// The steps of the local P1 recording test (2026-10-31), apart from the server that runs them
// (recording-test.mjs), so they can be checked against the website's own routes without a build.
// Each step talks to the site through `call(method, path, { as, body, headers })`, which answers
// { status, json }; `as: 'owner'` sends the test owner's sign-in.
//
// What the steps guarantee:
//   - lessons, tutors and students are TEST- codes only, so no real person is ever in a test;
//   - recording is allowed only after the operator types the exact phrase for this lesson, and
//     only then is consent recorded (the site's consent route takes TEST- codes only, and only
//     while the test has switched trial consent on);
//   - what is printed is codes, statuses and labels: no address, link, token or name.
import path from 'node:path';

export const TEST_CODE = /^TEST-[A-Za-z0-9-]{1,30}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}$/;

/** The phrase the operator types to allow this lesson to be recorded. */
export const confirmationFor = lessonCode => `RECORD ${lessonCode}`;

/**
 * Checks the Drive settings given on the command line and returns what the site's environment
 * gets for them. `local`: the site's local stand-in for Drive. `google`: the test account's grant
 * (two files outside the repository and outside OneDrive) and a folder whose name starts "[測試] ".
 */
export function driveSettings({ drive, clientFile, tokenFile, rootName }, repoRoot) {
  if (drive === 'local') return { CLASSROOM_DRIVE: 'local' };
  if (drive !== 'google') throw new Error('--drive is local or google');
  const outside = (file, flag) => {
    if (!file || !path.isAbsolute(file)) throw new Error(`Give ${flag} as a full path`);
    const resolved = path.resolve(file);
    if (!path.relative(repoRoot, resolved).startsWith('..')) throw new Error(`${flag} must be outside the repository`);
    if (/[\\/]OneDrive[^\\/]*[\\/]/i.test(resolved)) throw new Error(`${flag} must not be in a OneDrive folder, which copies it to the cloud`);
    return resolved;
  };
  const name = String(rootName ?? '[測試] iHear P1 錄影測試').trim();
  if (!name.startsWith('[測試] ')) throw new Error('The Drive folder for the test starts with "[測試] "');
  return {
    CLASSROOM_DRIVE: 'google',
    CLASSROOM_GOOGLE_CLIENT_FILE: outside(clientFile, '--google-client'),
    CLASSROOM_GOOGLE_TOKEN_FILE: outside(tokenFile, '--google-token'),
    CLASSROOM_DRIVE_ROOT_NAME: name,
  };
}

/** Adds one TEST- lesson through the site's admin route; returns its id, times and the student's link. */
export async function createTestLesson({ call, date, time, minutes = 30, code, tutorCode, studentCode, tutorEmail }) {
  for (const [flag, value] of [['--code', code], ['--tutor', tutorCode], ['--student', studentCode]]) {
    if (!TEST_CODE.test(String(value))) throw new Error(`${flag} must be a TEST- code`);
  }
  if (!DATE.test(String(date)) || !TIME.test(String(time))) throw new Error('Give --date YYYY-MM-DD and --time HH:MM (Taipei)');
  const created = await call('POST', '/api/admin/classrooms', { as: 'owner', body: { code, date, time, minutes, tutorCode, tutorEmail, studentCode } });
  if (created.status !== 201) throw new Error(`The lesson was not added (${created.status}${created.json?.code ? `, ${created.json.code}` : ''})`);
  return { lessonId: created.json.lesson.lessonId, code, startsAt: created.json.lesson.startsAt, endsAt: created.json.lesson.endsAt, studentLink: created.json.studentLink };
}

/**
 * Allows the lesson to be recorded, only if the operator types confirmationFor(code) exactly.
 * Then, and only then, trial consent is switched on and the student's consent and the tutor's
 * recording notice are recorded. Anything else allows nothing and records nothing.
 */
export async function allowRecording({ call, lesson, tutorCode, studentCode, ask, enableTrialConsent }) {
  const phrase = confirmationFor(lesson.code);
  const typed = String(await ask(`To allow lesson ${lesson.code} to be recorded, type: ${phrase}\n> `) ?? '').trim();
  if (typed !== phrase) return { allowed: false };
  enableTrialConsent();
  for (const [personCode, role] of [[studentCode, 'student'], [tutorCode, 'tutor']]) {
    const answer = await call('POST', '/api/admin/classrooms/consents', { as: 'owner', body: { personCode, role, status: 'granted' } });
    if (answer.status !== 200) throw new Error(`Consent for ${personCode} was not recorded (${answer.status}${answer.json?.code ? `, ${answer.json.code}` : ''})`);
  }
  return { allowed: true };
}

/** One run of the site's scheduled tick, as a scheduler would call it. */
export async function runTick({ call, cronSecret }) {
  const answer = await call('GET', '/api/classroom/scheduled-tick', { headers: { authorization: `Bearer ${cronSecret}` } });
  return { status: answer.status, summary: answer.json ?? null };
}

/** The lesson's card on the owner's overview, as a few lines of codes, statuses and labels. */
export async function lessonSummary({ call, lessonCode }) {
  const answer = await call('GET', '/api/admin/classrooms', { as: 'owner' });
  if (answer.status !== 200) return [`overview: ${answer.status}`];
  const groups = answer.json?.dashboard?.groups ?? {};
  for (const [group, cards] of Object.entries(groups)) {
    const card = cards.find(entry => entry.lessonCode === lessonCode);
    if (!card) continue;
    return [
      `${lessonCode}: ${group}`,
      `  recording: ${card.recording?.status ?? '-'} (${card.recording?.basis ?? '-'}) ${card.recording?.label ?? ''}`.trimEnd(),
      `  filing: ${card.filing?.status ?? '-'} ${card.filing?.label ?? ''}${card.filing?.reasonLabel ? ` / ${card.filing.reasonLabel}` : ''}`.trimEnd(),
      ...(card.anomalies ?? []).map(entry => `  ${entry.severity}: ${entry.code} ${entry.label ?? ''}`.trimEnd()),
    ];
  }
  return [`${lessonCode}: not on the overview`];
}
