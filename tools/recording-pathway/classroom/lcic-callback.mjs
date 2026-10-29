// Tencent LCIC's event callbacks, turned into the same minimized facts Zoom's notices become, so
// they share the store's dedupe, the recording decision and P1's filing. Written from LCIC's
// callback reference (2026-10-30): POST JSON {SdkAppId, Timestamp, ExpireTime, Sign, EventType,
// EventData}, answered with {"error_code":0}. Fields of MemberJoin/MemberQuit (RoomId, UserId) and
// the unit of RecordSize are NOT confirmed yet; check them against real deliveries.
import { dedupeKeyOf } from './webhook-ingest.mjs';

const toMs = seconds => (Number.isFinite(Number(seconds)) && Number(seconds) > 0 ? Number(seconds) * 1000 : null);

/**
 * One callback as facts. `lookup(roomId)` returns { lessonId, users } (users: our participant id
 * to LCIC UserId) for a room iHear created, or null for any other room.
 */
export async function minimizeLcicCallback(body, { lookup, receivedAt }) {
  const data = body?.EventData ?? {};
  const roomId = Number(data.RoomId);
  if (!Number.isSafeInteger(roomId)) return [];
  const known = await lookup(roomId);
  if (!known) return [];
  const base = { source: 'lcic_callback', lessonId: known.lessonId, providerSessionId: `lcic-${roomId}`, receivedAt };
  const occurredAt = toMs(body.Timestamp) ?? receivedAt;
  const participantOf = userId => Object.entries(known.users).find(([, value]) => value === String(userId))?.[0] ?? null;
  let fact = null;
  switch (body.EventType) {
    case 'RoomStart':
      fact = { ...base, type: 'session.started', occurredAt };
      break;
    case 'RoomEnd':
    case 'RoomExpire':
      fact = { ...base, type: 'session.ended', occurredAt };
      break;
    case 'MemberJoin':
    case 'MemberQuit':
      fact = {
        ...base, type: body.EventType === 'MemberJoin' ? 'session.user_joined' : 'session.user_left',
        participantId: participantOf(data.UserId), participantUuid: data.UserId == null ? null : `lcic-${data.UserId}`, occurredAt,
      };
      break;
    case 'RecordFinish': {
      const url = typeof data.RecordUrl === 'string' ? data.RecordUrl : '';
      const extension = (/\.([a-z0-9]{2,5})(?:\?|$)/i.exec(url)?.[1] ?? 'mp4').toLowerCase();
      // One mixed recording per class. The address itself is not stored: the download reads it
      // fresh from DescribeRoom, so no signed link sits in iHear's database.
      fact = {
        ...base, type: 'session.recording_completed', occurredAt,
        files: [{ providerFileId: `lcic-${roomId}`, kind: 'lcic_mixed', extension, size: Number(data.RecordSize) || 0, status: 'completed', recordingStart: null, recordingEnd: occurredAt }],
      };
      break;
    }
    default:
      return [];
  }
  return [{ ...fact, key: dedupeKeyOf(fact) }];
}
