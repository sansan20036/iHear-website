// One page per person and lesson in this browser (2026-11-19). On the production site the tutor was
// in one lesson up to three times at once (Zoom's own record of the session): each open tab is
// another Zoom participant with the same code, so the student saw and heard a different one than
// the tutor was using, and a whiteboard pressed in one tab met a screen share running in another.
// The block rooms already keep one tab per person (app/classroom/b/[blockId]/block-entry.tsx); the
// one-to-one room now does the same with the browser's Web Locks: entering takes the lesson's lock;
// a second tab finds it taken and says so; "continue here" takes it over, and the first tab, which
// loses it, leaves the room. Another device cannot be seen this way: the room says that case itself
// from Zoom's list of people (the adapter's "duplicate" event). Without Web Locks nothing is kept.

export type TabClaim = {
  // Gives the lesson up (leaving the room).
  release(): void;
  // Settles when another tab took the lesson over.
  lost: Promise<void>;
};

type Locks = {
  request(name: string, options: { ifAvailable?: boolean; steal?: boolean }, callback: (lock: unknown) => Promise<void> | undefined): Promise<unknown>;
};

/** A short tag for the person (a hash of the personal key; "staff" for a signed-in tutor), so the key itself is not in the lock's name. */
export function personTag(key: string | null): string {
  if (!key) return "staff";
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) hash = Math.imul(hash ^ key.charCodeAt(i), 0x01000193) >>> 0;
  return hash.toString(16);
}

export const lessonTabName = (lessonId: string, key: string | null) => `ihear-lesson:${lessonId}:${personTag(key)}`;

/** The lesson's lock for this tab: the claim, or null when another tab of this browser has it (unless `steal`). */
export function claimLessonTab(name: string, { steal = false, locks = (globalThis.navigator as Navigator & { locks?: Locks } | undefined)?.locks }: { steal?: boolean; locks?: Locks } = {}): Promise<TabClaim | null> {
  if (!locks?.request) return Promise.resolve({ release() {}, lost: new Promise<void>(() => {}) });
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  let markLost = () => {};
  const lost = new Promise<void>((resolve) => { markLost = resolve; });
  return new Promise((resolve) => {
    let granted = false;
    locks.request(name, steal ? { steal: true } : { ifAvailable: true }, (lock) => {
      if (!lock) { resolve(null); return undefined; }
      granted = true;
      resolve({ release, lost });
      return held;
    }).then(
      () => undefined,
      // Taken over by another tab (the browser ends this request with an AbortError).
      () => { if (granted) markLost(); else resolve(null); },
    );
  });
}
