// Round 12 (Gate B, 2026-11-22): the words every list shows for one recording's filing and what its
// retention did to the copy, one rule for the owners' list and the block's own page. Pure (no
// imports), so pages in the browser and tests use the same words.
//   - a copy deleted under the retention period: DELETED, never "ARCHIVED 歸檔完成";
//   - a deletion that needs a person, or is under way without an outcome: the copy's state is not
//     known, so it is not called archived either;
//   - a deletion that failed (Drive refused, or could not be read): still archived, with why.

export type ShownFiling = { status: string; retention?: { state: string; outcome?: string | null; reason?: string | null } | null };

const OUTCOME: Record<string, string> = { TRASHED: "在 Google Drive 垃圾桶，一段時間內還能救回", REMOVED: "已永久刪除" };
const REASON: Record<string, string> = {
  NOT_VISIBLE: "Drive 找不到這個檔案",
  NOT_THIS_RECORDING: "Drive 上的檔案不是這個錄影",
  DRIVE_REFUSED: "Drive 拒絕刪除",
  NOT_CHECKED: "無法讀取 Drive",
};

export function filingLabel({ status, retention }: ShownFiling): string {
  if (status === "DELETED") {
    const where = retention?.outcome ? OUTCOME[retention.outcome] : null;
    return `DELETED 已依保存期限刪除${where ? `（${where}）` : ""}`;
  }
  if (retention?.state === "NEEDS_PERSON") return `需要人工確認：保存期限刪除時${REASON[String(retention.reason)] ?? "無法確認檔案"}，檔案現況不明`;
  if (retention?.state === "DELETING") return "保存期限刪除進行中，尚未確認結果，檔案現況不明";
  const base = status === "ARCHIVED" || status === "STORED" ? "ARCHIVED 歸檔完成" : status;
  if (retention?.state === "DELETE_FAILED") return `${base}（上次保存期限刪除沒有完成：${REASON[String(retention.reason)] ?? "原因不明"}）`;
  return base;
}
