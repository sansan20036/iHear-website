import type { ReactNode } from "react";

// The room's control icons (2026-11-12): drawn here rather than taken from an icon library, in the
// colour of the button they sit in, and hidden from screen readers. Every button keeps its words
// (a short label under the icon, the rest for screen readers), so no control is an icon alone.
export type RoomIconName =
  | "microphone" | "microphone-off" | "camera" | "camera-off"
  | "hand" | "chat" | "leave" | "share" | "whiteboard" | "download";

const MICROPHONE = (
  <>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7" />
  </>
);
const CAMERA = (
  <>
    <rect x="3" y="6.5" width="12" height="11" rx="2.5" />
    <path d="M15 10.5l5-3v9l-5-3z" />
  </>
);
// The slash across a microphone or camera that is off, in the room's warning colour (classroom.css).
const OFF = <path className="classroom-room-icon-off" d="M4 4l16 16" />;

const SHAPES: Record<RoomIconName, ReactNode> = {
  microphone: MICROPHONE,
  "microphone-off": <>{MICROPHONE}{OFF}</>,
  camera: CAMERA,
  "camera-off": <>{CAMERA}{OFF}</>,
  hand: (
    <>
      <path d="M8 13.5V6a1.5 1.5 0 0 1 3 0v6" />
      <path d="M11 11.5V4.5a1.5 1.5 0 0 1 3 0v7" />
      <path d="M14 11.5V6a1.5 1.5 0 0 1 3 0v7" />
      <path d="M17 10a1.5 1.5 0 0 1 3 0v4a7 7 0 0 1-7 7h-1.2a6 6 0 0 1-4.9-2.6l-2.6-3.8a1.5 1.5 0 0 1 2.4-1.8L8 15" />
    </>
  ),
  chat: <path d="M20 11.5a7.5 7.5 0 0 1-10.9 6.7L4.5 19.5l1.2-3.9A7.5 7.5 0 1 1 20 11.5z" />,
  leave: (
    <>
      <path d="M14 4H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h7" />
      <path d="M10 12h10M16.5 8.5 20 12l-3.5 3.5" />
    </>
  ),
  share: (
    <>
      <rect x="3" y="4" width="18" height="13" rx="2" />
      <path d="M8 21h8M12 17v4M12 13.5V7.5M9.5 10l2.5-2.5 2.5 2.5" />
    </>
  ),
  whiteboard: (
    <>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M7 12.5l2.5-3 2.5 2 3-4M8.5 20l1.5-4M15.5 20l-1.5-4" />
    </>
  ),
  download: <path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 20h14" />,
};

export function RoomIcon({ name }: { name: RoomIconName }) {
  return (
    <svg className="classroom-room-icon" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor"
      strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {SHAPES[name]}
    </svg>
  );
}
