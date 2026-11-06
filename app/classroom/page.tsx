import type { Metadata } from "next";

import ClassroomHome from "./classroom-home";
import "./[lessonId]/classroom.css";
import "./classroom-home.css";

// The entry to iHear's online classroom (2026-11-06). The home page links here only at the end of
// the S3 acceptance. A tutor signs in and enters from "my lessons"; a student uses the personal
// link from iHear. The page itself holds no lesson data and is never indexed.
export const metadata: Metadata = {
  title: "iHear 線上教室",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function ClassroomPage() {
  return <ClassroomHome />;
}
