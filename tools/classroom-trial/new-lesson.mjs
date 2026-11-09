// Adds one TEST- lesson to the running trial server (local port only) and prints its two personal
// links, built on the tunnel's public address. The links are shown once; the server keeps hashes.
// Usage: node tools/classroom-trial/new-lesson.mjs --public https://<tunnel host> --date 2026-11-02 --time 09:00
//        [--minutes 60] [--code TEST-Z1] [--tutor TEST-T1] [--student TEST-S1] [--local http://127.0.0.1:3311]
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => (value.startsWith('--') ? [...pairs, [value.slice(2), all[index + 1]]] : pairs), []));
if (!args.public || !args.date || !args.time) {
  console.error('Usage: node tools/classroom-trial/new-lesson.mjs --public https://<tunnel host> --date YYYY-MM-DD --time HH:MM (Taipei)');
  process.exit(2);
}
const local = args.local ?? 'http://127.0.0.1:3311';
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(local)) throw new Error('The trial server is reached on this computer only');
const response = await fetch(`${local}/trial/lessons`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    publicOrigin: args.public, date: args.date, time: args.time, minutes: Number(args.minutes ?? 60),
    code: args.code ?? 'TEST-L1', tutorCode: args.tutor ?? 'TEST-T1', studentCode: args.student ?? 'TEST-S1',
  }),
});
const result = await response.json();
if (response.status !== 201) {
  console.error(`Not added (${response.status}):`, JSON.stringify(result));
  process.exit(1);
}
console.log(`Lesson ${result.lesson.code}, ${result.lesson.startsAt} – ${result.lesson.endsAt} (UTC); the room opens 15 minutes before.`);
console.log(`Tutor (adult tester in Taiwan): ${result.tutorLink}`);
console.log(`Student (adult tester in the US): ${result.studentLink}`);
console.log('Send each link to its tester only. Stopping the trial server ends both.');
