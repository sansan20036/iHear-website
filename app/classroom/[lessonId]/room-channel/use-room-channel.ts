"use client";

import { useEffect, useMemo, useRef, useState } from "react";

// @ts-ignore - the room channel's own code, plain JavaScript tested with node --test.
import { createRoomClient, toBoard } from "../../../../lib/room-channel/client.mjs";

// The room's own whiteboard, public chat and share turn, as a page holds them (local integration
// only, 2026-11-24). One hook owns the connection to the room channel's route; the pieces that
// draw (room-board.tsx, room-chat.tsx) and the page's own share button use what it returns.
//
// The page gives it the person's ticket (the same key the join and status calls use; it goes in
// the request body only, never into the page's markup) and, for the share turn, five things of the
// media adapter that this hook calls and never implements. Who the person is comes back from the
// server with the first answer ("you": their place on the lesson's list, which is also the
// userKey Zoom carries for them).

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
};
type Client = {
  start(): void; stop(): void; setIdle(value: boolean): void; view(): View;
  beginLine(options: { color: number; width: number }): string; addPoints(line: string, points: [number, number][]): boolean; endLine(line: string): void;
  erase(line: string): void; clear(): void; undoClear(): void; say(text: string): void;
  claimTurn(): void; releaseTurn(): void; handOver(to: string): void; showsShareOf(person: string): boolean;
};
type Changed = { board?: boolean; chat?: boolean; turn?: boolean | "lost"; refused?: { part: string; error: string; line?: string }[]; stopped?: string };

// The plain-JavaScript client, with the shapes this hook uses of it.
const makeClient = createRoomClient as unknown as (options: { post: (body: unknown) => Promise<{ status: number; body: unknown }>; key: string; changed: (what: Changed) => void }) => Client;

const EMPTY: View = { you: null, stopped: null, waiting: 0, board: { seq: 0, ended: false, lines: [], undo: null }, chat: { messages: [], ended: false }, turn: { holder: null, offeredTo: null, mine: false, offeredToMe: false } };
const REQUEST_MS = 10_000;
const CLAIM_MS = 6_000;

export type RoomChannel = ReturnType<typeof useRoomChannel>;

export function useRoomChannel({ lessonId, ticket, media = null, enabled = true }: { lessonId: string; ticket: string | null; media?: RoomChannelMedia | null; enabled?: boolean }) {
  const [view, setView] = useState<View>(EMPTY);
  // Which parts this classroom offers, as the server says with every answer (null: not known yet).
  const [parts, setParts] = useState<RoomChannelParts | null>(null);
  const [notice, setNotice] = useState<RoomChannelNotice | null>(null);
  const [online, setOnline] = useState(true);
  const [sharing, setSharing] = useState(false);
  const client = useRef<Client | null>(null);
  const mediaNow = useRef(media);
  mediaNow.current = media;
  const claim = useRef<{ settle: (got: boolean) => void } | null>(null);
  const sharingNow = useRef(false);

  useEffect(() => {
    if (!enabled || !ticket) return undefined;
    let alive = true;
    const post = async (body: unknown) => {
      const abort = new AbortController();
      const timer = window.setTimeout(() => abort.abort(), REQUEST_MS);
      try {
        const response = await fetch(`/api/classroom/${encodeURIComponent(lessonId)}/room-channel`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store", credentials: "same-origin", signal: abort.signal });
        const answer = await response.json().catch(() => null);
        if (alive) {
          setOnline(response.status < 500 && response.status !== 429);
          const offered = answer?.on;
          if (offered && typeof offered === "object") setParts((before) => (before && before.board === offered.board && before.chat === offered.chat && before.turn === offered.turn ? before : { board: offered.board === true, chat: offered.chat === true, turn: offered.turn === true }));
        }
        return { status: response.status, body: answer };
      } catch (error) {
        if (alive) setOnline(false);
        throw error;
      } finally {
        window.clearTimeout(timer);
      }
    };
    const stopOwnShare = () => {
      if (!sharingNow.current) return;
      sharingNow.current = false;
      setSharing(false);
      void mediaNow.current?.stopShare().catch(() => undefined);
    };
    const made: Client = makeClient({
      post, key: ticket,
      changed: (what: Changed) => {
        if (!alive) return;
        const next = made.view();
        setView(next);
        const refused = what.refused?.at(-1);
        if (refused) setNotice({ part: refused.part, code: refused.error, at: Date.now() });
        // The turn: a claim in waiting learns its answer; a turn lost (the connection was away longer
        // than the lease) stops this page's own share at once; everyone shows only the holder's stream.
        if (claim.current && (next.turn.mine || what.refused?.some((item) => item.part === "turn"))) { claim.current.settle(next.turn.mine); claim.current = null; }
        if (what.turn === "lost") { stopOwnShare(); setNotice({ part: "turn", code: "LOST", at: Date.now() }); }
        if (what.turn) mediaNow.current?.showShareOf(next.turn.holder);
        if (what.stopped) { stopOwnShare(); mediaNow.current?.showShareOf(null); }
      },
    });
    client.current = made;
    made.start();
    const seen = () => made.setIdle(document.hidden);
    document.addEventListener("visibilitychange", seen);
    // The person stopped the share with the browser's own button: the turn goes back at once.
    const unlisten = mediaNow.current?.onSharersChange(() => {
      const now = made.view();
      if (sharingNow.current && now.you && !mediaNow.current?.sharers().includes(now.you)) { sharingNow.current = false; setSharing(false); made.releaseTurn(); }
    });
    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", seen);
      unlisten?.();
      claim.current?.settle(false);
      claim.current = null;
      if (sharingNow.current) { sharingNow.current = false; made.releaseTurn(); }
      made.stop();
      client.current = null;
    };
  }, [enabled, lessonId, ticket]);

  return useMemo(() => {
    const act = <T,>(work: (made: Client) => T, otherwise: T): T => (client.current ? work(client.current) : otherwise);
    return {
      // null until the first answer; then what this classroom offers. The pieces show nothing for a part that is off.
      parts, you: view.you, stopped: view.stopped, online, waiting: view.waiting, notice,
      dismissNotice: () => setNotice(null),
      board: {
        lines: view.board.lines, undo: view.board.undo,
        // The lesson is over: the board can be looked at, not changed.
        ended: view.board.ended,
        // What this page has drawn and not yet heard back about is shown from the page's own copy: look at it again now.
        refresh: () => { if (client.current) setView(client.current.view()); },
        // A place in a box of the page (in pixels) as a point of the board.
        point: (x: number, y: number, width: number, height: number) => toBoard(x, y, width, height) as [number, number],
        begin: (color: number, width: number) => act((made) => made.beginLine({ color, width }), null as string | null),
        add: (line: string, points: [number, number][]) => act((made) => made.addPoints(line, points), false),
        end: (line: string) => act((made) => made.endLine(line), undefined),
        erase: (line: string) => act((made) => made.erase(line), undefined),
        clear: () => act((made) => made.clear(), undefined),
        undoClear: () => act((made) => made.undoClear(), undefined),
      },
      chat: { messages: view.chat.messages, ended: view.chat.ended, say: (text: string) => act((made) => made.say(text), undefined) },
      share: {
        holder: view.turn.holder, mine: view.turn.mine, offeredToMe: view.turn.offeredToMe, sharing,
        // Whether someone else holds the turn (the page's share button says so instead of starting).
        busy: view.turn.holder !== null && !view.turn.mine,
        // Ask the server for the turn first; only with it start the share. False: not started (the notice says why).
        start: async (): Promise<boolean> => {
          const made = client.current, adapter = mediaNow.current;
          if (!made || !adapter || sharingNow.current) return false;
          const got = made.view().turn.mine || await new Promise<boolean>((resolve) => {
            const timer = window.setTimeout(() => { if (claim.current) { claim.current = null; resolve(false); } }, CLAIM_MS);
            claim.current = { settle: (value) => { window.clearTimeout(timer); resolve(value); } };
            made.claimTurn();
          });
          if (!got) return false;
          const started = await adapter.startShare().catch(() => false);
          if (!started) { made.releaseTurn(); setNotice({ part: "turn", code: "NOT_STARTED", at: Date.now() }); return false; }
          sharingNow.current = true;
          setSharing(true);
          return true;
        },
        stop: async (): Promise<void> => {
          const made = client.current, adapter = mediaNow.current;
          sharingNow.current = false;
          setSharing(false);
          await adapter?.stopShare().catch(() => undefined);
          made?.releaseTurn();
        },
        // Give the turn to one named person; this page's own share stops first.
        handOver: async (to: string): Promise<void> => {
          const made = client.current, adapter = mediaNow.current;
          if (!made) return;
          if (sharingNow.current) { sharingNow.current = false; setSharing(false); await adapter?.stopShare().catch(() => undefined); }
          made.handOver(to);
        },
      },
    };
  }, [view, parts, notice, online, sharing]);
}
