"use client";

import { useCallback, useEffect, useState } from "react";

import { previewViewOf, type PreviewView } from "../../../lib/classroom-lobby";

// The pre-class screen's look at its lesson (2026-11-13): asked once the page has taken the personal
// key from the address (ready), again for a new link opened in the same tab, and when the person
// presses "Check again". The key goes in the body, never in an address. An answer that takes longer
// than PREVIEW_WAIT_MS counts as "could not be checked", so the way in is never held up by it.
const PREVIEW_WAIT_MS = 8_000;

export function useLessonPreview(lessonId: string, joinKey: string | null, ready: boolean) {
  const [view, setView] = useState<PreviewView>({ kind: "loading" });
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (!ready) return;
    let stopped = false;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), PREVIEW_WAIT_MS);
    setView({ kind: "loading" });
    (async () => {
      try {
        const response = await fetch(`/api/classroom/${encodeURIComponent(lessonId)}/preview`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(joinKey ? { key: joinKey } : {}),
          cache: "no-store",
          signal: abort.signal,
        });
        const data = await response.json().catch(() => null);
        if (!stopped) setView(previewViewOf(response.status, data, Boolean(joinKey)));
      } catch {
        if (!stopped) setView({ kind: "unknown" });
      } finally {
        clearTimeout(timer);
      }
    })();
    return () => {
      stopped = true;
      clearTimeout(timer);
      abort.abort();
    };
  }, [lessonId, joinKey, ready, round]);
  const recheck = useCallback(() => setRound((value) => value + 1), []);
  return { view, recheck };
}
