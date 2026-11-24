"use client";

import { useEffect, useMemo, useRef, useState } from "react";

// @ts-ignore - the room channel's own code, plain JavaScript tested with node --test.
import { createRoomClient, toBoard } from "../../../../lib/room-channel/client.mjs";
// @ts-ignore - as above.
import { createShareControl } from "../../../../lib/room-channel/share-control.mjs";

// The room's own whiteboard, public chat and share turn, as a page holds them (local integration
// only, 2026-11-24). One hook owns the connection to the room channel's route; the pieces that
// draw (room-board.tsx, room-chat.tsx) and the page's own share button use what it returns.
//
// The page gives it the person's ticket (the same key the join and status calls use; it goes in
// the request body only, never into the page's markup) and, for the share turn, five things of the
// media adapter that this hook calls and never implements. Who the person is comes back from the
// server with the first answer ("you": their place on the lesson's list, which is also the
// userKey Zoom carries for them).
//
// The rules themselves are not here: what is sent and when, and what a lost connection does, are
// lib/room-channel/client.mjs; "never share without the turn" is lib/room-channel/share-control.mjs.
// Both run under node --test.

export type RoomChannelMedia = {
  startShare(): Promise<boolean>;
  stopShare(): Promise<void>;
  // The userKeys Zoom says are sharing now, and a way to hear when that changes.
  sharers(): string[];
  onSharersChange(listener: () => void): () => void;
  // Which one stream the page shows (null: none).
  showShareOf(userKey: string | null): void;
};
export type RoomChannelParts = { board: boolean; chat: boolean; turn: boolean };
export type BoardLine = { line: string; by: string | null; color: number; width: number; points: [number, number][]; done: boolean; unconfirmed?: boolean };
export type ChatMessage = { seq: number; at: number; by: string; name: string; text: string };
export type RoomChannelNotice = { part: string; code: string; at: number };
type View = {
  you: string | null; stopped: string | null; waiting: number;
  board: { seq: number; ended: boolean; lines: BoardLine[]; undo: { clear: number; until: number } | null };
  chat: { messages: ChatMessage[]; ended: boolean };
  turn: { holder: string | null; offeredTo: string | null; mine: boolean; offeredToMe: boolean };
  people: readonly { id: string; name: string }[];
};
type Changed = { board?: boolean; chat?: boolean; turn?: boolean | "lost"; people?: boolean; refused?: { part: string; error: string; line?: string }[]; stopped?: string };
type Client = {
  start(): void; stop(): void; setIdle(value: boolean): void; view(): View;
  beginLine(options: { color: number; width: number }): string; addPoints(line: string, points: [number, number][]): boolean; endLine(line: string): void;
  erase(line: string): void; clear(): void; undoClear(): void; say(text: string): void;
  claimTurn(): void; releaseTurn(): void; handOver(to: string): void; showsShareOf(person: string): boolean;
  parting(what: { turn: boolean }): unknown;
};
type ShareControl = { sharing: boolean; holding: boolean; changed(what: Changed): void; start(): Promise<boolean>; stop(): Promise<void>; handOver(to: string): Promise<void>; close(): void };

// The plain-JavaScript pieces, with the shapes this hook uses of them.
const makeClient = createRoomClient as unknown as (options: { post: (body: unknown) => Promise<{ status: number; body: unknown }>; key: string; changed: (what: Changed) => void }) => Client;
const makeShare = createShareControl as unknown as (options: { client: Client; media: RoomChannelMedia; notify: (what: { sharing: boolean; notice?: string }) => void }) => ShareControl;
const boardPoint = toBoard as unknown as (x: number, y: number, width: number, height: number) => [number, number];

const EMPTY: View = { you: null, stopped: null, waiting: 0, board: { seq: 0, ended: false, lines: [], undo: null }, chat: { messages: [], ended: false }, turn: { holder: null, offeredTo: null, mine: false, offeredToMe: false }, people: [] };
const REQUEST_MS = 10_000;
// A media adapter that does nothing, for a page that mounts the board and the chat without the turn.
const NO_MEDIA: RoomChannelMedia = { startShare: async () => false, stopShare: async () => undefined, sharers: () => [], onSharersChange: () => () => undefined, showShareOf: () => undefined };

export type RoomChannel = ReturnType<typeof useRoomChannel>;

export function useRoomChannel({ lessonId, ticket, media = null, enabled = true }: { lessonId: string; ticket: string | null; media?: RoomChannelMedia | null; enabled?: boolean }) {
  const [view, setView] = useState<View>(EMPTY);
  // Which parts this classroom offers, as the server says with every answer (null: not known yet).
  const [parts, setParts] = useState<RoomChannelParts | null>(null);
  const [notice, setNotice] = useState<RoomChannelNotice | null>(null);
  const [online, setOnline] = useState(true);
  const [sharing, setSharing] = useState(false);
  const client = useRef<Client | null>(null);
  const share = useRef<ShareControl | null>(null);
  // The adapter may be made after the room is entered: the latest one given is the one used.
  const mediaNow = useRef<RoomChannelMedia>(media ?? NO_MEDIA);
  mediaNow.current = media ?? NO_MEDIA;

  useEffect(() => {
    if (!enabled || !ticket) return undefined;
    let alive = true;
    const address = `/api/classroom/${encodeURIComponent(lessonId)}/room-channel`;
    const post = async (body: unknown) => {
      const abort = new AbortController();
      const timer = window.setTimeout(() => abort.abort(), REQUEST_MS);
      try {
        const response = await fetch(address, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store", credentials: "same-origin", signal: abort.signal });
        const answer = await response.json().catch(() => null);
        if (alive) {
          setOnline(response.status < 500 && response.status !== 429);
          const offered = answer?.on;
          if (offered && typeof offered === "object") setParts((before) => (before && before.board === offered.board && before.chat === offered.chat && before.turn === offered.turn ? before : { board: offered.board === true, chat: offered.chat === true, turn: offered.turn === true }));
        }
        return { status: response.status, body: answer as unknown };
      } catch (error) {
        if (alive) setOnline(false);
        throw error;
      } finally {
        window.clearTimeout(timer);
      }
    };
    // The adapter's five things, always the latest given.
    const adapter: RoomChannelMedia = {
      startShare: () => mediaNow.current.startShare(), stopShare: () => mediaNow.current.stopShare(), sharers: () => mediaNow.current.sharers(),
      onSharersChange: (listener) => {
        let given = mediaNow.current;
        let off = given.onSharersChange(listener);
        const again = window.setInterval(() => { if (mediaNow.current !== given) { off(); given = mediaNow.current; off = given.onSharersChange(listener); } }, 2000);
        return () => { window.clearInterval(again); off(); };
      },
      showShareOf: (userKey) => mediaNow.current.showShareOf(userKey),
    };
    const control: { current: ShareControl | null } = { current: null };
    const made = makeClient({
      post, key: ticket,
      changed: (what) => {
        if (!alive) return;
        setView(made.view());
        const refused = what.refused?.at(-1);
        if (refused) setNotice({ part: refused.part, code: refused.error, at: Date.now() });
        control.current?.changed(what);
      },
    });
    control.current = makeShare({ client: made, media: adapter, notify: (what) => { if (!alive) return; setSharing(what.sharing); if (what.notice) setNotice({ part: "turn", code: what.notice, at: Date.now() }); } });
    client.current = made;
    share.current = control.current;
    made.start();
    const seen = () => made.setIdle(document.hidden);
    document.addEventListener("visibilitychange", seen);
    // The page goes away while it shares (closed, reloaded, the room left): its turn goes back with
    // one last request, which the browser sends even as the page is unloaded (its "beacon", or a
    // request marked "keepalive" where there is none). Without it the turn would only be free when
    // its 15 seconds ran out. Never for a turn another window of the same person holds: only this
    // page's own share counts. (Sent twice it does no harm: the second gives back nothing.)
    const part = () => {
      const body = control.current?.holding ? made.parting({ turn: true }) : null;
      if (!body) return;
      const words = JSON.stringify(body);
      let handed = false;
      try { handed = typeof navigator.sendBeacon === "function" && navigator.sendBeacon(address, new Blob([words], { type: "application/json" })); } catch { handed = false; }
      if (!handed) void fetch(address, { method: "POST", headers: { "content-type": "application/json" }, body: words, cache: "no-store", credentials: "same-origin", keepalive: true }).catch(() => undefined);
    };
    window.addEventListener("pagehide", part);
    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", seen);
      window.removeEventListener("pagehide", part);
      part();
      control.current?.close();
      made.stop();
      client.current = null;
      share.current = null;
    };
  }, [enabled, lessonId, ticket]);

  return useMemo(() => {
    const act = <T,>(work: (made: Client) => T, otherwise: T): T => (client.current ? work(client.current) : otherwise);
    return {
      // null until the first answer; then what this classroom offers. The pieces show nothing for a part that is off.
      parts, you: view.you, stopped: view.stopped, online, waiting: view.waiting, notice,
      // With the share turn: who is in the lesson now, as the server names them ({ id, name }; the
      // person's own entry is among them). Empty without the turn.
      people: view.people,
      dismissNotice: () => setNotice(null),
      board: {
        lines: view.board.lines, undo: view.board.undo,
        // The lesson is over: the board can be looked at, not changed.
        ended: view.board.ended,
        // What this page has drawn and not yet heard back about is shown from the page's own copy: look at it again now.
        refresh: () => { if (client.current) setView(client.current.view()); },
        // A place in a box of the page (in pixels) as a point of the board.
        point: (x: number, y: number, width: number, height: number) => boardPoint(x, y, width, height),
        begin: (color: number, width: number) => act((made) => made.beginLine({ color, width }), null as string | null),
        add: (line: string, points: [number, number][]) => act((made) => made.addPoints(line, points), false),
        end: (line: string) => act((made) => made.endLine(line), undefined),
        erase: (line: string) => act((made) => made.erase(line), undefined),
        clear: () => act((made) => made.clear(), undefined),
        undoClear: () => act((made) => made.undoClear(), undefined),
      },
      chat: { messages: view.chat.messages, ended: view.chat.ended, say: (text: string) => act((made) => made.say(text), undefined) },
      share: {
        holder: view.turn.holder, mine: view.turn.mine, offeredTo: view.turn.offeredTo, offeredToMe: view.turn.offeredToMe, sharing,
        // Whether someone else holds the turn (the page's share button says so instead of starting).
        busy: view.turn.holder !== null && !view.turn.mine,
        // Ask the server for the turn first; only with it start the share. False: not started (the notice says why).
        start: (): Promise<boolean> => share.current?.start() ?? Promise.resolve(false),
        stop: (): Promise<void> => share.current?.stop() ?? Promise.resolve(),
        // Give the turn to one named person; this page's own share stops first.
        handOver: (to: string): Promise<void> => share.current?.handOver(to) ?? Promise.resolve(),
      },
    };
  }, [view, parts, notice, online, sharing]);
}
