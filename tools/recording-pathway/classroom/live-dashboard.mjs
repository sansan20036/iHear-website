// Administrator live classroom overview (synthetic prototype).
//
// The cards are built field by field from the derived lesson state, never by passing event
// data through, so names, e-mail addresses, Zoom display names, IP addresses, download links,
// tokens and keys cannot reach the page. Students and tutors appear by code only. Until the
// permission model grows, only website owners may see the overview, and observing a classroom
// stays switched off.
import { deriveLesson } from './lesson-state.mjs';

// Same headers as the existing administrator routes: every answer, including a denial, stays
// private and uncached.
export const DASHBOARD_HEADERS = Object.freeze({
  'Cache-Control': 'private, no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
});

export const LABELS = Object.freeze({
  phase: { WAITING: '等待開始', LIVE: '進行中', ENDED: '已結束' },
  attendance: {
    NOT_JOINED: '未到',
    PRESENT: '在線',
    RECONNECTING: '重新連線中',
    POSSIBLY_OFFLINE: '可能離線',
    LEFT: '已離開',
  },
  leaveReason: { DISCONNECTED: '斷線', LEFT: '自行離開', HOST_ENDED: '課程結束', REMOVED: '被移出', OTHER: '其他' },
  recording: {
    NOT_REQUESTED: '未開始',
    BLOCKED: '不錄影（同意條件不符）',
    START_REQUESTED: '已送出錄影啟動請求',
    RECORDING: '錄影中',
    PAUSED: '暫停',
    STOPPED: '已停止，等待錄影檔',
    POSSIBLY_STOPPED: '可能已停止',
    FAILED: '錄影失敗',
    COMPLETED: '錄影已完成',
  },
  filing: { NONE: '', PENDING: '歸檔中', STORED: '已歸檔', HELD: '已隔離或暫緩，待管理員處理', BLOCKED: '歸檔暫停，待管理員處理', FAILED: '歸檔失敗' },
  filingBlocked: {
    DRIVE_QUOTA: '雲端硬碟空間不足',
    DRIVE_AUTH: '雲端硬碟授權失效',
    DRIVE_FOLDER_MISSING: '歸檔資料夾不存在或無權限',
    VENDOR_AUTH: 'Zoom 下載授權失效',
  },
  basis: { confirmed: '已確認', requested: '已請求，等待 Zoom 確認', inferred: '推測' },
  dataState: { REALTIME: '即時', DELAYED: '延遲', ANOMALY: '異常' },
  anomaly: {
    TUTOR_ABSENT: '小老師未到',
    STUDENT_ABSENT: '學生未到',
    START_UNCONFIRMED: '錄影啟動未獲 Zoom 確認',
    RECORDING_FAILED: '錄影啟動失敗',
    RECORDING_STOPPED_UNEXPECTEDLY: '錄影意外停止',
    UNAPPROVED_RECORDING_START: '出現未經核准的錄影',
    CONSENT_WITHDRAWN: '課中撤回錄影同意',
    WITHDRAWAL_STOP_UNCONFIRMED: '撤回同意後仍無法確認錄影已停止',
    FILE_OVERDUE: '錄影檔逾時未到',
    FILING_FAILED: '歸檔失敗',
    FILING_BLOCKED: '歸檔暫停（需管理員處理）',
    FILING_DELAYED: '歸檔延遲',
    PART_OUT_OF_ORDER: '分段編號與錄影先後不符',
    UNKNOWN_PARTICIPANT: '出現身分不明的參與者',
    STALE_DATA: '資料可能過時',
    HOST_SIGNAL_LOST: '小老師端訊號中斷',
    QUALITY_ALERT: '連線品質不穩',
    OVERRUN: '超過表定時間仍未結束',
    JOIN_BLOCKED: '有人入場被擋',
  },
});

const iso = value => (value == null ? null : new Date(value).toISOString());

function label(kind, value, basis) {
  const text = LABELS[kind][value] ?? value;
  return basis === 'inferred' ? `${text}（推測）` : text;
}

function personCard(entry) {
  let text = label('attendance', entry.status, entry.basis);
  if (entry.status === 'LEFT' && entry.leaveReason && entry.basis === 'confirmed') text = `已離開（${LABELS.leaveReason[entry.leaveReason] ?? '其他'}）`;
  if (entry.late) text += '，遲到';
  return { code: entry.code, status: entry.status, basis: entry.basis, label: text, since: iso(entry.since) };
}

function recordingCard(recording) {
  let text = label('recording', recording.status, recording.basis);
  if (recording.status === 'START_REQUESTED' && recording.retrying) text += '（重試中）';
  if (recording.status === 'RECORDING' && recording.pending === 'STOP_REQUESTED') text += '（已送出停止請求）';
  if (recording.lateConfirmation) text += '（延遲確認）';
  return {
    status: recording.status,
    basis: recording.basis,
    basisLabel: LABELS.basis[recording.basis],
    source: recording.basis === 'confirmed' ? recording.source ?? null : null,
    reason: recording.reason ?? null,
    label: text,
    since: iso(recording.since),
  };
}

export function lessonCard(state, now) {
  const tutor = state.attendance.find(entry => entry.role === 'tutor');
  return {
    lessonCode: state.code,
    scheduledStart: iso(state.scheduledStart),
    actualStart: iso(state.actualStart),
    phase: { value: state.phase.value, basis: state.phase.basis, label: label('phase', state.phase.value, state.phase.basis) },
    tutor: tutor ? personCard(tutor) : null,
    students: state.attendance.filter(entry => entry.role === 'student').map(personCard),
    recording: recordingCard(state.recording),
    filing: {
      status: state.filing.status,
      label: LABELS.filing[state.filing.status],
      files: state.filing.files,
      stored: state.filing.stored,
      reason: state.filing.reason ?? null,
      reasonLabel: LABELS.filingBlocked[state.filing.reason] ?? null,
    },
    anomalies: state.anomalies.map(entry => ({
      code: entry.code,
      severity: entry.severity,
      label: LABELS.anomaly[entry.code] ?? entry.code,
      reason: entry.reason ?? null,
      count: entry.count ?? null,
      since: iso(entry.since),
    })),
    dataState: {
      value: state.dataState.value,
      label: LABELS.dataState[state.dataState.value],
      lastConfirmedAt: iso(state.dataState.lastConfirmedAt),
      ageSeconds: state.dataState.lastConfirmedAt == null ? null : Math.round((now - state.dataState.lastConfirmedAt) / 1000),
    },
  };
}

// The four groups the administrator sees. A lesson with an error-level anomaly goes to 異常
// whatever its phase; its card still shows the phase.
export function buildDashboard({ lessons, events, now }) {
  const byLesson = new Map(lessons.map(lesson => [lesson.id, []]));
  for (const event of events) byLesson.get(event.lessonId)?.push(event);
  const groups = { ANOMALY: [], LIVE: [], WAITING: [], ENDED: [] };
  for (const lesson of [...lessons].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt) || a.code.localeCompare(b.code))) {
    const state = deriveLesson(lesson, byLesson.get(lesson.id), now);
    const card = lessonCard(state, now);
    groups[state.dataState.value === 'ANOMALY' ? 'ANOMALY' : state.phase.value].push(card);
  }
  return {
    generatedAt: iso(now),
    groups,
    counts: Object.fromEntries(Object.entries(groups).map(([key, cards]) => [key, cards.length])),
  };
}

// Mirrors the existing /api/admin/me route: no session is 401, a signed-in account without the
// right is 403. In the MVP only owners have the right.
export function dashboardAccess({ email, principal }) {
  if (!email) return { status: 401, code: 'SIGN_IN_REQUIRED' };
  if (!canViewDashboard(principal)) return { status: 403, code: 'FORBIDDEN' };
  return { status: 200, code: 'OK' };
}

export function canViewDashboard(principal) {
  return principal?.role === 'owner';
}

// Observing a classroom is a later candidate: its own permission, a feature switch that is off,
// and owners only even then.
export function canObserve(principal, features = { observe: false }) {
  return features.observe === true && principal?.role === 'owner' && Array.isArray(principal.permissions) && principal.permissions.includes('classroom.observe');
}
