import { describe, expect, test } from "vitest";
import { singleImageFromTransfer, transferFiles, transferHasFiles } from "../assets/image-intake.js";

function transfer(files = [], items = []) {
  return { files, items };
}

describe("image transfer intake", () => {
  test("uses the concrete files exposed by drop or clipboard data", () => {
    const photo = { name: "portrait.png", type: "image/png" };
    expect(transferFiles(transfer([photo]))).toEqual([photo]);
    expect(transferHasFiles(transfer([photo]))).toBe(true);
    expect(singleImageFromTransfer(transfer([photo]))).toEqual({ status: "ready", file: photo });
  });

  test("falls back to file clipboard items", () => {
    const photo = { name: "pasted.webp", type: "image/webp" };
    const input = transfer([], [
      { kind: "string", getAsFile: () => null },
      { kind: "file", getAsFile: () => photo },
    ]);
    expect(singleImageFromTransfer(input)).toEqual({ status: "ready", file: photo });
  });

  test("reports empty and multiple transfers without guessing", () => {
    expect(singleImageFromTransfer(transfer())).toEqual({ status: "empty", file: null });
    expect(singleImageFromTransfer(transfer([{ name: "one.png" }, { name: "two.png" }]))).toEqual({ status: "multiple", file: null });
  });
});
