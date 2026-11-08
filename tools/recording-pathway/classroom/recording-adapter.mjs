// The Recording Adapter contract (2026-10-31): the one boundary between a video vendor and P1.
//
// A vendor's adapter does three things, and P1 knows nothing else about the vendor:
//   normalize(notice)          the vendor's own notice (webhook, callback or API answer) as iHear
//                              recording facts, checked by validateRecordingFact below;
//   download(record, range)    one byte range of a finished recording, read fresh from the vendor
//                              each time (no signed link is ever stored);
//   deleteVendorCopy(record)   removes the vendor's copy once P1 has stored and verified the file.
// In the website, normalize lives in tools/recording-pathway/classroom (webhook-ingest.mjs for
// Zoom, lcic-callback.mjs for LCIC) and download and deleteVendorCopy are the ClassroomProvider's
// download() and deleteRecording() in lib/classroom-vendors.
//
// A recording fact (type 'session.recording_completed', iHear's internal name for "a session's
// recording files are ready", kept from the first vendor) says which vendor, which session and
// which lesson (iHear's own lesson id, carried in the session the website created), and for each
// file only identifiers, a neutral kind, the extension, the size and the recording times. Where
// the file is comes from the vendor and its file id: the adapter looks the address up when it
// downloads. P1 files the 'composite' kind (the combined lesson video) and nothing else. Vendors
// name their recording types differently, so each adapter maps its own to these kinds; a new
// vendor adds its entry to VENDORS and passes the contract tests, and P1 stays unchanged.

export const RECORDING_KINDS = Object.freeze(['composite', 'audio', 'chat', 'transcript', 'other']);
// Only the combined lesson video is filed.
export const FILED_KINDS = Object.freeze(['composite']);

// The vendors P1 takes recordings from, by the names the classroom uses (lib/classroom-media.ts),
// plus the synthetic stand-in. For each: its recording types as neutral kinds (a type not listed
// is 'other' and not filed) and the prefix of its file ids. Recording files are keyed by the file
// id alone (migration 028), so every vendor after the first namespaces its ids.
export const VENDORS = Object.freeze({
  // Zoom Video SDK cloud recording types; the combined screen-and-speaker view is the lesson video.
  'zoom-video-sdk': vendor('', {
    shared_screen_with_speaker_view: 'composite',
    audio_only: 'audio',
    chat_file: 'chat',
    audio_transcript: 'transcript',
    closed_caption: 'transcript',
  }),
  // Tencent LCIC records one mixed video per class; its file id is lcic-<RoomId>.
  'tencent-lcic': vendor('lcic-', { lcic_mixed: 'composite' }),
  // The synthetic stand-in speaks the neutral kinds, and Zoom's types where it imitates Zoom's answers.
  synthetic: vendor('', {
    ...Object.fromEntries(RECORDING_KINDS.map(kind => [kind, kind])),
    shared_screen_with_speaker_view: 'composite', audio_only: 'audio', chat_file: 'chat', audio_transcript: 'transcript',
  }),
});

function vendor(fileIdPrefix, kinds) {
  return Object.freeze({ fileIdPrefix, kinds: Object.freeze(kinds) });
}

// Own keys only, so a type called 'constructor' is not mistaken for a mapping.
export const isVendor = provider => Object.hasOwn(VENDORS, String(provider));

export function neutralKind(provider, vendorKind) {
  const kinds = isVendor(provider) ? VENDORS[provider].kinds : {};
  return Object.hasOwn(kinds, String(vendorKind)) ? kinds[vendorKind] : 'other';
}

export const isFiledKind = kind => FILED_KINDS.includes(kind);

// Keys that would carry a person or a way into a file: P1 never receives them.
const FORBIDDEN_KEY = /^(download_?url|downloadurl|play_?url|url|uri|token|access_?token|download_?access_?token|password|passcode|e?mail|user_?name|display_?name|name|topic)$/i;
export const LESSON_ID = /^[A-Za-z0-9-]{1,36}$/;
const EXTENSION = /^[a-z0-9]{0,5}$/;

function forbiddenKeys(value, path, found) {
  if (Array.isArray(value)) value.forEach((entry, index) => forbiddenKeys(entry, `${path}[${index}]`, found));
  else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      if (FORBIDDEN_KEY.test(key)) found.push(`${path}.${key}`);
      forbiddenKeys(entry, `${path}.${key}`, found);
    }
  }
  return found;
}

/** The problems with one recording fact; an empty list means P1 may take it. */
export function validateRecordingFact(fact) {
  const problems = [];
  const at = (path, message) => problems.push(`${path}: ${message}`);
  if (fact?.type !== 'session.recording_completed') at('type', 'must be session.recording_completed');
  const registered = isVendor(fact?.provider) ? VENDORS[fact.provider] : null;
  if (!registered) at('provider', `one of the registered vendors (${Object.keys(VENDORS).join(', ')})`);
  if (fact?.providerSessionId != null && (typeof fact.providerSessionId !== 'string' || !fact.providerSessionId)) at('providerSessionId', 'the vendor session id, or null');
  if (fact?.lessonId != null && !LESSON_ID.test(String(fact.lessonId))) at('lessonId', 'an iHear lesson id, or null when the vendor session is not one of ours');
  if (!Array.isArray(fact?.files) || !fact.files.length) at('files', 'at least one file');
  for (const [index, file] of (Array.isArray(fact?.files) ? fact.files : []).entries()) {
    const path = `files[${index}]`;
    if (typeof file?.providerFileId !== 'string' || file.providerFileId.length < 1 || file.providerFileId.length > 200) at(`${path}.providerFileId`, '1 to 200 characters');
    else if (registered?.fileIdPrefix && !file.providerFileId.startsWith(registered.fileIdPrefix)) at(`${path}.providerFileId`, `${fact.provider} file ids start with ${registered.fileIdPrefix}`);
    if (!RECORDING_KINDS.includes(file?.kind)) at(`${path}.kind`, `one of ${RECORDING_KINDS.join(', ')}`);
    if (typeof file?.extension !== 'string' || !EXTENSION.test(file.extension)) at(`${path}.extension`, 'lower-case letters and digits, at most 5');
    if (!Number.isSafeInteger(file?.size) || file.size < 0) at(`${path}.size`, 'a whole number of bytes from 0');
    // P1 checks every copy against this size before it counts as stored.
    else if (isFiledKind(file.kind) && file.size < 1) at(`${path}.size`, 'a lesson video needs its size in bytes, or its copy cannot be verified');
    for (const time of ['recordingStart', 'recordingEnd']) if (file?.[time] != null && !Number.isFinite(file[time])) at(`${path}.${time}`, 'milliseconds, or null');
    if (Number.isFinite(file?.recordingStart) && Number.isFinite(file?.recordingEnd) && file.recordingStart > file.recordingEnd) at(path, 'starts after it ends');
  }
  for (const path of forbiddenKeys(fact, 'fact', [])) at(path, 'not allowed: names, links and tokens stay with the vendor');
  return problems;
}

/** The problems with an adapter object; an empty list means it has everything P1 calls. */
export function assertRecordingAdapter(adapter) {
  const problems = [];
  if (!isVendor(adapter?.provider)) problems.push(`provider: one of the registered vendors (${Object.keys(VENDORS).join(', ')})`);
  for (const member of ['normalize', 'download', 'deleteVendorCopy']) if (typeof adapter?.[member] !== 'function') problems.push(`${member}: must be a function`);
  return problems;
}
