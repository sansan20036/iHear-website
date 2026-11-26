// The one room channel of this server process (local integration only, 2026-11-23): the service
// over PostgreSQL when the site has a database address, else over a store in memory (local runs
// and tests; it is gone when the process ends). The same choice as lib/classroom-store.ts makes.
//
// With a database it opens a small pool of its own (at most 2 connections), because the classroom
// store's client is private to its file. Sharing that one client is a small change in a file that
// is not this folder's; it is asked of its owner before any release.
import postgres from "postgres";

import { sharedSql } from "../shared-sql";

// @ts-ignore - the room channel's own code, plain JavaScript tested with node --test.
import { createRoomChannel } from "./service.mjs";
// @ts-ignore - as above.
import { createMemoryStore } from "./store-memory.mjs";
// @ts-ignore - as above.
import { createPostgresStore } from "./store-postgres.mjs";

type Exchange = (input: { lesson: unknown; who: unknown; on: unknown; cursors?: unknown; send?: unknown; now: number }) => Promise<Record<string, unknown>>;
type Sweep = (input: { now: number; limit?: number; lessonFacts?: ((lessonId: string) => Promise<unknown>) | null }) => Promise<Record<string, unknown>>;
export type RoomChannel = { exchange: Exchange; sweep: Sweep; close: (lesson: unknown) => Promise<void> };

const globalForRoomChannel = globalThis as unknown as { ihearRoomChannel?: RoomChannel; ihearRoomChannelSql?: postgres.Sql };

export function roomChannel(): RoomChannel {
  if (globalForRoomChannel.ihearRoomChannel) return globalForRoomChannel.ihearRoomChannel;
  const databaseUrl = process.env.IHEAR_FORCE_FILE_STORE === "1" ? "" : process.env.POSTGRES_URL || process.env.DATABASE_URL || "";
  if (databaseUrl) {
    // Round 18c: the site's one pool per instance (lib/shared-sql.ts), not a second one of its own.
    globalForRoomChannel.ihearRoomChannelSql ??= sharedSql(databaseUrl);
    globalForRoomChannel.ihearRoomChannel = createRoomChannel(createPostgresStore(globalForRoomChannel.ihearRoomChannelSql)) as RoomChannel;
  } else {
    globalForRoomChannel.ihearRoomChannel = createRoomChannel(createMemoryStore()) as RoomChannel;
  }
  return globalForRoomChannel.ihearRoomChannel;
}
