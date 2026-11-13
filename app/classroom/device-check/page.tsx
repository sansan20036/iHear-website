import type { Metadata } from "next";

import DeviceCheckPage from "./device-check-page";
import "../[lessonId]/classroom.css";
import "../classroom-lobby.css";

// The device check of the Classroom 2.1 lobby (2026-11-13), on its own page: /classroom itself may
// not use the camera or microphone (the site's Permissions-Policy allows them only on the classroom's
// own pages, /classroom/<id>, which this address shares). It holds no lesson data and is never indexed.
export const metadata: Metadata = {
  title: "iHear 線上教室",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function ClassroomDeviceCheckPage() {
  return <DeviceCheckPage />;
}
