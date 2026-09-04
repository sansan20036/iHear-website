export function transferFiles(transfer) {
  if (!transfer) return [];
  const directFiles = Array.from(transfer.files || []).filter(Boolean);
  if (directFiles.length) return directFiles;
  return Array.from(transfer.items || [])
    .filter((item) => item?.kind === "file")
    .map((item) => item.getAsFile?.())
    .filter(Boolean);
}

export function singleImageFromTransfer(transfer) {
  const files = transferFiles(transfer);
  if (!files.length) return { status: "empty", file: null };
  if (files.length > 1) return { status: "multiple", file: null };
  return { status: "ready", file: files[0] };
}

export function transferHasFiles(transfer) {
  return transferFiles(transfer).length > 0;
}
