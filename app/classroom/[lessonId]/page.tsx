import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { LESSON_ID_PATTERN } from "../../../lib/classroom-link";
import ClassroomEntry from "./classroom-entry";
import "./classroom.css";
import "../classroom-lobby.css";

export const dynamic = "force-dynamic";

// Personal join links carry a key in the address, so the page is never indexed and never sends
// its address to another site.
export const metadata: Metadata = {
  title: "iHear Classroom",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

type Props = { params: Promise<{ lessonId: string }> };

export default async function ClassroomPage({ params }: Props) {
  const { lessonId } = await params;
  if (!LESSON_ID_PATTERN.test(lessonId)) notFound();
  return <ClassroomEntry lessonId={lessonId} synthetic={process.env.CLASSROOM_PROVIDER === "synthetic"} />;
}
