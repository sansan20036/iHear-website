import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { fixedRoomsEnabled, ROOM_ID } from "../../../../lib/classroom-fixed-rooms";
import RoomDoor from "./room-door";
import "../../[lessonId]/classroom.css";
import "../../join/join.css";

export const dynamic = "force-dynamic";

// Classroom 3.0 round 3 (2026-11-21): a fixed room's link (lib/classroom-fixed-rooms.ts). Never
// indexed, no referrer; 404 while switched off (CLASSROOM_FIXED_ROOMS), as in production until approved.
export const metadata: Metadata = {
  title: "iHear 線上教室",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function FixedRoomPage({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await params;
  if (!fixedRoomsEnabled() || !ROOM_ID.test(roomId)) notFound();
  return <RoomDoor roomId={roomId} />;
}
