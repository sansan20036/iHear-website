// Recording actions that change a Zoom session (start, stop, end) are carried out by one executor
// at a time (G1, 2026-11-09). Each action already has a stable key from the planner
// (start:<lesson>:g1:1, stop:..., end:...); that key is the operation's id. Its state is stored
// under op:<key> before Zoom is asked, and every change to it is one atomic step in the store
// (a row-locked transaction on PostgreSQL, one serialized write in the file store), so several
// server instances, ticks at the same time, a crashed run or an expired lease never send the same
// action twice at once.
//
//   IN_FLIGHT     claimed: its owner is asking Zoom (until leaseUntil)
//   UNCERTAIN     asked, but Zoom's answer was lost (no answer, or a 5xx): Zoom may have done it
//   UNKNOWN       checked, and Zoom's state could not be told: flagged; checked again after a
//                 while; a start is never sent again blindly
//   NOT_EXECUTED  Zoom did not do it (its state says so, or the server refused before asking):
//                 it may be asked afresh
//   DONE          Zoom answered (accepted or refused), or its state shows it happened
//
// Whoever claims an operation whose last owner may have reached Zoom (IN_FLIGHT past its lease,
// UNCERTAIN, UNKNOWN) asks Zoom's state first, never resending blindly.

export const OPERATION = Object.freeze({
  // Longer than one request to Zoom (15 s) times a few sessions; then another executor may take over.
  leaseMs: 90_000,
  // How long an UNKNOWN operation waits before Zoom's state is asked again.
  unknownRetryMs: 60_000,
});
export const OPERATION_EVENT = 'server.operation';
export const OPERATED = new Set(['START_RECORDING', 'STOP_RECORDING', 'END_SESSION']);
export const operationKey = actionKey => `op:${actionKey}`;

// Whether the last owner may have reached Zoom: then Zoom's state is asked before anything is sent.
export const mayHaveReachedZoom = state => state === 'IN_FLIGHT' || state === 'UNCERTAIN' || state === 'UNKNOWN';

/**
 * @typedef {{ operation: string, lessonId: string, action: string, params: Record<string, unknown>, state: string,
 *   owner: string | null, leaseUntil: number | null, version: number, attempts: number, since: number, updatedAt: number,
 *   previous?: string | null, outcome?: Record<string, unknown> }} OperationData
 */

// The claim, from the stored state (null: never claimed). `input` carries the operation's key,
// lesson, action and parameters, the owner and the time. The parameters (where the action goes)
// and the start time are kept from the first claim while an earlier attempt may have reached Zoom,
// so Zoom's state is asked where it may have gone. After NOT_EXECUTED (refused at its own check,
// or Zoom's state showed it did not happen) nothing reached Zoom, so the action is planned afresh:
// the plan's parameters as they are now (a start goes to the session the lesson is in now).
/**
 * @param {any} current
 * @param {{ operation: string, lessonId?: string, action?: string, params?: Record<string, unknown> | null, owner: string, now: number, leaseMs?: number, unknownRetryMs?: number }} input
 * @returns {{ acquired: false, state: any, previous?: undefined, next?: undefined } | { acquired: true, state?: undefined, previous: any, next: OperationData }}
 */
export function claimFor(current, { operation, lessonId, action, params, owner, now, leaseMs = OPERATION.leaseMs, unknownRetryMs = OPERATION.unknownRetryMs }) {
  const state = current?.state ?? null;
  const claimable = !current || state === 'UNCERTAIN' || state === 'NOT_EXECUTED'
    || (state === 'IN_FLIGHT' && !(current.leaseUntil > now))
    || (state === 'UNKNOWN' && now >= current.updatedAt + unknownRetryMs);
  if (!claimable) return { acquired: false, state };
  const fresh = state === 'NOT_EXECUTED' && params != null;
  const next = {
    operation: current?.operation ?? operation,
    lessonId: current?.lessonId ?? lessonId,
    action: current?.action ?? action,
    params: fresh ? params : current?.params ?? params ?? {},
    state: 'IN_FLIGHT',
    owner,
    leaseUntil: now + leaseMs,
    version: (current?.version ?? 0) + 1,
    attempts: (current?.attempts ?? 0) + 1,
    since: fresh ? now : current?.since ?? now,
    updatedAt: now,
    previous: state,
    ...(current?.outcome ? { outcome: current.outcome } : {}),
  };
  return { acquired: true, previous: state, next };
}

// The owner's result, only while it still holds the claim (same version, still IN_FLIGHT): a run
// whose lease ran out and was taken over is fenced out and changes nothing.
/**
 * @param {any} current
 * @param {{ version: number, state: string, outcome?: Record<string, unknown>, now: number }} input
 * @returns {OperationData | null}
 */
export function finishFor(current, { version, state, outcome, now }) {
  if (!current || current.state !== 'IN_FLIGHT' || current.version !== version) return null;
  return { ...current, state, owner: null, leaseUntil: null, updatedAt: now, ...(outcome ? { outcome } : {}) };
}

// The stored form: an event row keyed op:<key>, its time the first claim, received at its last change.
/** @param {OperationData} data */
export function operationEvent(data) {
  return { source: 'server', type: OPERATION_EVENT, key: operationKey(data.operation), occurredAt: data.since, receivedAt: data.updatedAt, ...data };
}

// Zoom's answer to a request: definite when it answered with a 2xx (accepted) or a 4xx (refused);
// lost when there was no answer (a timeout, a broken connection) or a 5xx (it may have acted).
export const answerLost = httpStatus => !(httpStatus >= 200 && httpStatus < 500);
