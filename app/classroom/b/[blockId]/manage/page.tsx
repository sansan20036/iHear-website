import type { Metadata } from "next";
import { notFound } from "next/navigation";

import BlockManage from "./block-manage";
import "../block.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "iHear Classroom — 班次管理",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

const BLOCK_ID_PATTERN = /^B-[0-9a-f]{32}$/;
type Props = { params: Promise<{ blockId: string }> };

// P3-Multi: the manager's page for one block. Who may see and change it is decided by the server
// on every request (the block's manager, signed in, or a site owner).
export default async function BlockManagePage({ params }: Props) {
  const { blockId } = await params;
  if (!BLOCK_ID_PATTERN.test(blockId)) notFound();
  return <BlockManage blockId={blockId} />;
}
