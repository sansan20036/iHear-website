import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ClassroomProvider, ProviderCall } from "../classroom-provider";
import type { ClassroomLesson, ClassroomParticipant } from "../classroom-store";
import { fetchTransport, setting, type VendorTransport } from "./http";

// Tencent LCIC (Low-code Interactive Classroom) on the server. LCIC is a complete classroom
// page (video, courseware, whiteboard, recording) that iHear embeds in an iframe; the iHear
// server registers the two people, creates one room per lesson and logs each person in. Written
// from Tencent's API reference (2026-10-30); NOT yet run against a real LCIC application.
//   API: POST https://lcic.intl.tencentcloudapi.com, Version 2022-08-17, TC3-HMAC-SHA256
//   RegisterUser {SdkAppId, Name, OriginId} -> {UserId}; LoginUser {UserId} -> {Token} (7 days)
//   CreateRoom {Name, StartTime, EndTime, SdkAppId, Resolution, MaxMicNumber, SubType, TeacherId,
//               DisableRecord (0 = record the whole class, 1 = never)} -> {RoomId}
//   Join: https://www.tencentclass.com/latest/class.html?classid=&userid=&token=
// Recording is decided when the room is created: a room made before consent is decided, or
// without it, never records. Starting or stopping it mid-class from the server, ending a class
// and removing a person are not documented, so those answer 501 and the overview raises its
// usual anomaly (a withdrawal that cannot be stopped is an error for a person to handle).

export const LCIC_API_VERSION = "2022-08-17";
export const LCIC_CLASS_PAGE = "https://www.tencentclass.com/latest/class.html";
const LOGIN_TOKEN_MS = 7 * 24 * 60 * 60 * 1000;

export type TencentLcicConfig = { sdkAppId: number; secretId: string; secretKey: string; callbackKey: string; host: string };

export function tencentLcicConfig(env: Record<string, string | undefined>): TencentLcicConfig | null {
  const sdkAppId = Number(setting(env, "LCIC_SDK_APP_ID"));
  const secretId = setting(env, "TENCENTCLOUD_SECRET_ID"), secretKey = setting(env, "TENCENTCLOUD_SECRET_KEY");
  const callbackKey = setting(env, "LCIC_CALLBACK_KEY");
  if (!Number.isSafeInteger(sdkAppId) || sdkAppId <= 0 || !secretId || !secretKey || !callbackKey) return null;
  return { sdkAppId, secretId, secretKey, callbackKey, host: setting(env, "LCIC_API_HOST") || "lcic.intl.tencentcloudapi.com" };
}

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const hmac = (key: Buffer | string, value: string) => createHmac("sha256", key).update(value, "utf8").digest();

/** Tencent Cloud API signature v3 (TC3-HMAC-SHA256), signing content-type and host. */
export function tc3Sign(input: { secretId: string; secretKey: string; service: string; host: string; action: string; version: string; timestamp: number; payload: string; region?: string }) {
  const date = new Date(input.timestamp * 1000).toISOString().slice(0, 10);
  const canonicalRequest = ["POST", "/", "", "content-type:application/json; charset=utf-8", `host:${input.host}`, "", "content-type;host", sha256(input.payload)].join("\n");
  const scope = `${date}/${input.service}/tc3_request`;
  const stringToSign = ["TC3-HMAC-SHA256", String(input.timestamp), scope, sha256(canonicalRequest)].join("\n");
  const signing = hmac(hmac(hmac(`TC3${input.secretKey}`, date), input.service), "tc3_request");
  const signature = createHmac("sha256", signing).update(stringToSign, "utf8").digest("hex");
  return {
    canonicalRequest, stringToSign, signature,
    headers: {
      Authorization: `TC3-HMAC-SHA256 Credential=${input.secretId}/${scope}, SignedHeaders=content-type;host, Signature=${signature}`,
      "Content-Type": "application/json; charset=utf-8",
      Host: input.host,
      "X-TC-Action": input.action,
      "X-TC-Timestamp": String(input.timestamp),
      "X-TC-Version": input.version,
      ...(input.region ? { "X-TC-Region": input.region } : {}),
    },
  };
}

export class LcicApiError extends Error {
  constructor(readonly action: string, readonly code: string) {
    super(`LCIC ${action} failed: ${code}`);
    this.name = "LcicApiError";
  }
}

export async function lcicCall(config: TencentLcicConfig, transport: VendorTransport, action: string, params: Record<string, unknown>, now: number) {
  const payload = JSON.stringify(params);
  const { headers } = tc3Sign({ secretId: config.secretId, secretKey: config.secretKey, service: "lcic", host: config.host, action, version: LCIC_API_VERSION, timestamp: Math.floor(now / 1000), payload });
  const response = await transport({ method: "POST", url: `https://${config.host}/`, headers, body: payload });
  let parsed: { Response?: Record<string, unknown> & { Error?: { Code?: string } } } | null = null;
  try { parsed = JSON.parse(response.body); } catch { /* reported below */ }
  const result = parsed?.Response;
  // Only the error code is kept: Tencent's messages may repeat request details.
  if (response.status !== 200 || !result || result.Error) throw new LcicApiError(action, String(result?.Error?.Code || `HTTP_${response.status}`));
  return result;
}

/** Which LCIC room and users belong to a lesson. Local file for the prototype; a table before production. */
export type LcicRoom = { roomId: number; recordingDisabled: boolean; users: Record<string, string> };
export type LcicRoomRegistry = {
  get(lessonId: string): Promise<LcicRoom | null>;
  set(lessonId: string, room: LcicRoom): Promise<void>;
  lessonOfRoom(roomId: number): Promise<{ lessonId: string; room: LcicRoom } | null>;
};

export function fileRoomRegistry(file = path.join(process.env.IHEAR_TEST_DATA_DIR || path.join(process.cwd(), "data"), "lcic-rooms.json")): LcicRoomRegistry {
  let queue: Promise<unknown> = Promise.resolve();
  const read = async (): Promise<Record<string, LcicRoom>> => {
    try { return JSON.parse(await readFile(file, "utf8")); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  };
  return {
    get: async (lessonId) => (await read())[lessonId] ?? null,
    set(lessonId, room) {
      const operation = queue.then(async () => { const all = await read(); all[lessonId] = room; await writeFile(file, `${JSON.stringify(all, null, 2)}\n`, "utf8"); });
      queue = operation.catch(() => undefined);
      return operation;
    },
    async lessonOfRoom(roomId) {
      const entry = Object.entries(await read()).find(([, room]) => room.roomId === roomId);
      return entry ? { lessonId: entry[0], room: entry[1] } : null;
    },
  };
}

export function memoryRoomRegistry(): LcicRoomRegistry {
  const rooms = new Map<string, LcicRoom>();
  return {
    get: async (lessonId) => rooms.get(lessonId) ?? null,
    set: async (lessonId, room) => { rooms.set(lessonId, structuredClone(room)); },
    lessonOfRoom: async (roomId) => { for (const [lessonId, room] of rooms) if (room.roomId === roomId) return { lessonId, room }; return null; },
  };
}

/** md5(CallbackKey + ExpireTime), as LCIC signs its callbacks; also refuses an expired one. */
export function verifyLcicCallback(body: { Sign?: unknown; ExpireTime?: unknown; SdkAppId?: unknown }, config: Pick<TencentLcicConfig, "callbackKey" | "sdkAppId">, now: number) {
  if (Number(body.SdkAppId) !== config.sdkAppId) return "wrong application";
  const expireTime = Number(body.ExpireTime);
  if (!Number.isSafeInteger(expireTime) || expireTime * 1000 < now) return "expired";
  const expected = Buffer.from(createHash("md5").update(`${config.callbackKey}${expireTime}`).digest("hex"));
  const given = Buffer.from(String(body.Sign ?? ""));
  return given.length === expected.length && timingSafeEqual(given, expected) ? null : "bad signature";
}

type Options = {
  transport?: VendorTransport;
  rooms: LcicRoomRegistry;
  // The server's recording decision for the lesson at the moment the room is created.
  recordingAllowed: (lesson: ClassroomLesson) => Promise<boolean>;
  now?: () => number;
};

const notDocumented = async (): Promise<ProviderCall> => ({ ok: false, httpStatus: 501 });

export function tencentLcicProvider(config: TencentLcicConfig, options: Options): ClassroomProvider {
  const transport = options.transport ?? fetchTransport;
  const now = options.now ?? Date.now;
  const api = (action: string, params: Record<string, unknown>) => lcicCall(config, transport, action, params, now());

  async function userOf(room: LcicRoom | null, participant: ClassroomParticipant) {
    const known = room?.users[participant.id];
    if (known) return known;
    // OriginId is our participant id, so LCIC never holds a name or e-mail address.
    const registered = await api("RegisterUser", { SdkAppId: config.sdkAppId, Name: participant.code, OriginId: participant.id });
    if (typeof registered.UserId !== "string") throw new LcicApiError("RegisterUser", "NO_USER_ID");
    return registered.UserId;
  }

  async function roomOf(lesson: ClassroomLesson) {
    const existing = await options.rooms.get(lesson.id);
    if (existing) return existing;
    const tutor = lesson.participants.find(entry => entry.role === "tutor");
    if (!tutor) throw new LcicApiError("CreateRoom", "NO_TUTOR");
    const users: Record<string, string> = {};
    for (const participant of lesson.participants) users[participant.id] = await userOf(null, participant);
    // Never recorded unless the server has already decided the lesson may be recorded.
    const recordingDisabled = !(await options.recordingAllowed(lesson));
    const created = await api("CreateRoom", {
      Name: lesson.code, StartTime: Math.floor(Date.parse(lesson.startsAt) / 1000), EndTime: Math.floor(Date.parse(lesson.endsAt) / 1000),
      SdkAppId: config.sdkAppId, Resolution: 2, MaxMicNumber: 1, SubType: "videodoc", TeacherId: users[tutor.id],
      AutoMic: 1, DisableRecord: recordingDisabled ? 1 : 0, RoomType: 0,
    });
    if (typeof created.RoomId !== "number") throw new LcicApiError("CreateRoom", "NO_ROOM_ID");
    const room = { roomId: created.RoomId, recordingDisabled, users };
    await options.rooms.set(lesson.id, room);
    return room;
  }

  return {
    name: "tencent-lcic",
    webhookSecret: null,
    sessionToken() { throw new Error("LCIC joins through prepareJoin"); },
    async prepareJoin({ lesson, participant }) {
      const room = await roomOf(lesson);
      const userId = room.users[participant.id] ?? await userOf(room, participant);
      if (!room.users[participant.id]) await options.rooms.set(lesson.id, { ...room, users: { ...room.users, [participant.id]: userId } });
      const login = await api("LoginUser", { UserId: userId });
      if (typeof login.Token !== "string") throw new LcicApiError("LoginUser", "NO_TOKEN");
      const issuedAt = now();
      const url = new URL(LCIC_CLASS_PAGE);
      url.searchParams.set("classid", String(room.roomId));
      url.searchParams.set("userid", userId);
      url.searchParams.set("token", login.Token);
      return { kind: "embed", token: login.Token, issuedAt, expiresAt: issuedAt + LOGIN_TOKEN_MS, embedUrl: url.toString(), recordingDisabled: room.recordingDisabled };
    },
    startRecording: notDocumented,
    stopRecording: notDocumented,
    endSession: notDocumented,
    removeUser: notDocumented,
    async snapshot(lesson) {
      const room = await options.rooms.get(lesson.id);
      if (!room) return null;
      const details = await api("DescribeRoom", { RoomId: room.roomId });
      return { lessonId: lesson.id, providerSessionId: `lcic-${room.roomId}`, details, users: [], recordings: typeof details.RecordUrl === "string" && details.RecordUrl ? [{ id: `lcic-${room.roomId}`, recording_type: "lcic_mixed" }] : [] };
    },
    // The recording address comes from DescribeRoom each time (it exists only after the class).
    async download(record, { start, end }) {
      const room = record.lessonId ? await options.rooms.get(String(record.lessonId)) : null;
      if (!room) throw new Error("No LCIC room for this recording");
      const details = await api("DescribeRoom", { RoomId: room.roomId });
      const url = typeof details.RecordUrl === "string" ? details.RecordUrl : "";
      if (!url.startsWith("https://")) throw new Error("The recording's address is not available yet");
      const response = await transport({ method: "GET", url, headers: { Range: `bytes=${start}-${end - 1}` } });
      if (response.status !== 206 && !(response.status === 200 && start === 0)) throw new Error(`Download answered ${response.status}`);
      return response.bytes ?? Buffer.from(response.body);
    },
    deleteRecording: notDocumented,
  };
}
