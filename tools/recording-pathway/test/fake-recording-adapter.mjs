// Recording Adapters over simulated recordings, for the P1/P3 integration tests: one for each
// vendor shape iHear has (Zoom Video SDK's webhook, Tencent LCIC's callback) and one for a
// synthetic vendor whose notices look like neither, standing in for the next vendor. All three
// share one simulated vendor (createVendor in fake-classroom-store.mjs: a fixed byte pattern per
// file id, injectable faults) and remember the deletions they are asked for. No account, network
// or real recording is involved; passing proves nothing about a real vendor's payloads.
import { minimizeLcicCallback } from '../classroom/lcic-callback.mjs';
import { neutralKind } from '../classroom/recording-adapter.mjs';
import { dedupeKeyOf, minimizeZoomEvent } from '../classroom/webhook-ingest.mjs';
import { createVendor } from './fake-classroom-store.mjs';

const toMs = value => (value == null || value === '' ? null : Date.parse(value));

// The vendor's side: downloads of simulated bytes, and deletions it answers either as done
// ('ok') or as not available ('unsupported': 501, what Zoom's adapter answers until its delete
// API is confirmed).
export function createVendorBackend({ clock = null, msPerByte = 0, deletion = 'ok' } = {}) {
  const vendor = createVendor({ clock, msPerByte });
  const deletions = [];
  return {
    vendor,
    deletions,
    download: (record, range) => vendor.download(record, range),
    async deleteVendorCopy(record) {
      deletions.push(record.providerFileId);
      return deletion === 'ok' ? { ok: true, httpStatus: 204 } : { ok: false, httpStatus: 501 };
    },
  };
}

// Zoom's notices arrive as signed webhooks; ingestWebhook verifies them and normalizes with
// minimizeZoomEvent, which is this adapter's normalize.
export function zoomAdapter(backend) {
  return {
    provider: 'zoom-video-sdk',
    normalize: (event, { receivedAt }) => [minimizeZoomEvent(event, receivedAt)].filter(Boolean),
    download: backend.download,
    deleteVendorCopy: backend.deleteVendorCopy,
  };
}

// LCIC's callbacks name a room; `rooms` maps the rooms iHear created to their lessons.
export function lcicAdapter(backend, rooms) {
  return {
    provider: 'tencent-lcic',
    normalize: (body, { receivedAt }) => minimizeLcicCallback(body, { lookup: async roomId => rooms.get(roomId) ?? null, receivedAt }),
    download: backend.download,
    deleteVendorCopy: backend.deleteVendorCopy,
  };
}

// A vendor of its own shape: { room, lesson, finishedAt, files: [{ fileId, type, format, bytes,
// from, to, state, link }] }. Its adapter drops the signed link (the download asks the vendor
// again), lower-cases the format, maps the type to a neutral kind and reports a session only
// once every file in it is ready, as Zoom's reconciliation does.
export function syntheticAdapter(backend) {
  return {
    provider: 'synthetic',
    normalize(notice, { receivedAt }) {
      const files = notice?.files ?? [];
      if (!files.length || files.some(file => file.state !== 'ready')) return [];
      const fact = {
        source: 'synthetic_notice',
        type: 'session.recording_completed',
        provider: 'synthetic',
        lessonId: notice.lesson ?? null,
        providerSessionId: notice.room ?? null,
        receivedAt,
        occurredAt: toMs(notice.finishedAt) ?? receivedAt,
        files: files.map(file => ({
          providerFileId: String(file.fileId),
          kind: neutralKind('synthetic', file.type),
          extension: String(file.format ?? '').toLowerCase(),
          size: Number(file.bytes) || 0,
          status: 'completed',
          recordingStart: toMs(file.from),
          recordingEnd: toMs(file.to),
        })),
      };
      return [{ ...fact, key: dedupeKeyOf(fact) }];
    },
    download: backend.download,
    deleteVendorCopy: backend.deleteVendorCopy,
  };
}
