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
  // After the emergency stop: only a confirmation from the video service counts as stopped.
  emergencyStop: {
    CONFIRMED: '視訊服務已確認錄影停止',
    WAITING: '已送出停止請求，等待視訊服務確認（尚未確認停止）',
    NO_RECORDING_KNOWN: '目前沒有已知進行中的錄影（這不是視訊服務的確認）；這堂課之後不會再錄影',
  },
  // Where a filed copy went: Google Drive, or the local stand-in used for synthetic tests.
  destination: { google: 'Google Drive', local: '本機模擬 Drive（合成測試，不是 Google Drive）' },
  storedIn: { google: '已存入 Google Drive', local: '已存入本機模擬 Drive（合成測試，不是 Google Drive）' },
  // Why a lesson is not recorded, where it is not the consent rule.
  recordingBlocked: { EMERGENCY_STOP: '已緊急停止，這堂課不再錄影', CONSENT_WITHDRAWN: '不錄影（已撤回同意）', LESSON_CANCELLED: '課程已取消，這堂課不再錄影' },
  // Recording in the current room after the room moved (a link revoked or reissued).
  roomRecording: {
    RECHECK_PENDING: '已換到新教室：伺服器正在重新確認課程、名單和同意',
    RECHECK_REFUSED: '已換到新教室：重新確認未通過，新教室不錄影（取得有效同意後，伺服器會自動再確認）',
    WAITING_FOR_AUTHORIZATION: '已換到新教室：新教室不會自動錄影，需要擁有者授權並重新確認同意',
    ALLOWED: '已換到新教室：重新確認通過，可以在新教室錄影',
    BLOCKED: '已換到新教室：這堂課不再錄影',
  },
  filing: { NONE: '', PENDING: '歸檔中', STORED: '已歸檔', HELD: '已隔離或暫緩，待管理員處理', BLOCKED: '歸檔暫停，待管理員處理', FAILED: '歸檔失敗' },
  // One recording file's outcome.
  filingItem: {
    PENDING: '等待歸檔', STORED: '已存入雲端硬碟', QUARANTINED: '已隔離到 _待確認', HOLD: '保留在視訊服務，不歸檔',
    SKIPPED: '不需歸檔', BLOCKED: '歸檔暫停', FAILED: '歸檔失敗',
  },
  filingBlocked: {
    DRIVE_QUOTA: '雲端硬碟空間不足',
    DRIVE_AUTH: '雲端硬碟授權失效',
    DRIVE_FOLDER_MISSING: '歸檔資料夾不存在或無權限',
    DRIVE_SHARING: '歸檔資料夾的共用範圍超出錄影政策（例如「知道連結的任何人」），未存入；原檔保留在視訊服務',
    VENDOR_AUTH: '視訊服務下載授權失效',
    // Reasons a filing failed for good (shown with 歸檔失敗).
    VENDOR_FILE_GONE: '視訊服務上已沒有這個錄影檔',
    SIZE_MISMATCH: '錄影檔大小與視訊服務的通知不符，未存入（原檔保留）',
  },
  basis: { confirmed: '已確認', requested: '已請求，等待視訊服務確認', inferred: '推測' },
  dataState: { REALTIME: '即時', DELAYED: '延遲', ANOMALY: '異常' },
  anomaly: {
    TUTOR_ABSENT: '小老師未到',
    STUDENT_ABSENT: '學生未到',
    START_UNCONFIRMED: '錄影啟動未獲視訊服務確認',
    RECORDING_FAILED: '錄影啟動失敗',
    RECORDING_STOPPED_UNEXPECTEDLY: '錄影意外停止',
    UNAPPROVED_RECORDING_START: '出現未經核准的錄影',
    CONSENT_WITHDRAWN: '課中撤回錄影同意',
    WITHDRAWAL_STOP_UNCONFIRMED: '撤回同意後仍無法確認錄影已停止',
    EMERGENCY_STOP: '管理員已按下緊急停止錄影',
    EMERGENCY_STOP_UNCONFIRMED: '緊急停止後仍無法確認錄影已停止',
    LESSON_CANCELLED: '課程已取消（伺服器已要求停止錄影並結束教室）',
    LESSON_CANCELLED_STOP_UNCONFIRMED: '課程取消後仍無法確認錄影已停止',
    // Requested is not ended: only Zoom's own notice or answer confirms an end (G-2).
    SESSION_END_UNCONFIRMED: '已要求結束教室，視訊服務尚未確認結束（伺服器會再試）',
    OLD_ROOM_SUSPECT: '舊教室中有不在名單上或使用舊連結的人（伺服器正在停止錄影並結束舊教室）',
    // Requested is not stopped: an old room's recording counts as stopped only on Zoom's word.
    OLD_ROOM_STOP_UNCONFIRMED: '舊教室的錄影尚未確認停止（伺服器會再要求停止並結束舊教室；這不是安全停止）',
    LESSON_END_STOP_UNCONFIRMED: '下課後仍無法確認錄影已停止',
    FILE_OVERDUE: '錄影檔逾時未到',
    FILING_FAILED: '歸檔失敗',
    FILING_BLOCKED: '歸檔暫停（需管理員處理）',
    FILING_DELAYED: '歸檔延遲',
    PART_OUT_OF_ORDER: '分段編號與錄影先後不符',
    RECORDING_REFUSED: '錄影通知格式不符，未交給歸檔（需管理員處理）',
    SESSION_REJECTED: '小老師頁回報的視訊 session 無法確認屬於這堂課（不會使用）',
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
  if (recording.status === 'BLOCKED' && LABELS.recordingBlocked[recording.reason]) text = LABELS.recordingBlocked[recording.reason];
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

// One recording file, field by field: P1's file name and folder (codes and dates only), size,
// Drive's checksum and file id. Never the vendor's file name or download link.
function filingItemCard(item) {
  // A copy in the local stand-in never reads as Google Drive.
  const where = LABELS.destination[item.destination] ?? null;
  let text = LABELS.filingItem[item.status] ?? item.status;
  if (item.status === 'STORED') text = LABELS.storedIn[item.destination] ?? '已存入雲端硬碟';
  else if (item.status === 'QUARANTINED' && item.destination === 'local') text += `（${where}）`;
  return {
    // Which room (generation) the file was recorded in: 0 the lesson's first room.
    generation: item.generation ?? null,
    extension: item.extension,
    recordingStart: iso(item.recordingStart),
    recordingEnd: iso(item.recordingEnd),
    status: item.status,
    destination: item.destination ?? null,
    label: text,
    reason: item.reason,
    reasonLabel: LABELS.filingBlocked[item.reason] ?? null,
    at: iso(item.at),
    name: item.name,
    folder: item.folder,
    size: item.size,
    md5: item.md5,
    driveFileId: item.driveFileId,
  };
}

// The emergency stop is offered while recording could still be running or start: before and
// during the lesson, or while the last recording state says it may be on.
const MAY_RECORD = new Set(['START_REQUESTED', 'RECORDING', 'PAUSED']);
function emergencyCard(state) {
  if (state.emergency) {
    const stopState = state.emergency.stopState;
    return { pressedAt: iso(state.emergency.at), stopState, stopLabel: LABELS.emergencyStop[stopState] ?? stopState, available: false };
  }
  return { pressedAt: null, stopState: null, stopLabel: null, available: state.phase.value !== 'ENDED' || MAY_RECORD.has(state.recording.status) };
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
      items: (state.filing.items ?? []).map(filingItemCard),
    },
    emergency: emergencyCard(state),
    // After the room moved: whether the new room may record, and whether an owner can authorize
    // it now (codes and labels only).
    roomRecording: state.roomRecording
      ? {
        generation: state.roomRecording.generation,
        status: state.roomRecording.status,
        label: LABELS.roomRecording[state.roomRecording.status] ?? state.roomRecording.status,
        reason: state.roomRecording.reason ?? null,
        canAuthorize: state.roomRecording.canAuthorize === true,
        oldRoomStillRecording: state.roomRecording.oldRoomStillRecording === true,
      }
      : null,
    // A cancelled lesson's stop, with the same three states as the emergency stop: confirmed only
    // on the video service's word.
    cancellation: state.cancellation
      ? { cancelledAt: iso(state.cancellation.at), stopState: state.cancellation.stopState, stopLabel: LABELS.emergencyStop[state.cancellation.stopState] ?? state.cancellation.stopState }
      : null,
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
