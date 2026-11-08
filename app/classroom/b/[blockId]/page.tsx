import type { Metadata } from "next";
import { notFound } from "next/navigation";

import BlockEntry from "./block-entry";
import "../../[lessonId]/classroom.css";
import "./block.css";

export const dynamic = "force-dynamic";

// P3-Multi (2026-11-09): a block's page. A student's personal link carries its key behind #, so
// the page is never indexed and never sends its address to another site.
export const metadata: Metadata = {
  title: "iHear Classroom",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

const BLOCK_ID_PATTERN = /^B-[0-9a-f]{32}$/;
type Props = { params: Promise<{ blockId: string }> };

export default async function BlockPage({ params }: Props) {
  const { blockId } = await params;
  if (!BLOCK_ID_PATTERN.test(blockId)) notFound();
  return <BlockEntry blockId={blockId} synthetic={process.env.CLASSROOM_PROVIDER === "synthetic"} />;
}
