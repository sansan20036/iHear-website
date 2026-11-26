// Round 18c (the third real-Zoom sitting, 2026-11-27): a TEST-ONLY choice of how Zoom draws the videos,
// to try "a video covers its tile" again. With inside-render alone, Zoom's own code said "Unsupported
// inside render type: 0" and drew nothing; it also reads inside-render-type, whose values are 1
// (VideoTag), 2 (WebGL), 3 (WebGL2) and 4 (WebGPU) — read from the SDK 2.6.0, not from Zoom's
// documents, so only a real session can show which works.
// Off unless a page is opened with ?zoom-render=videotag|webgl|webgl2, and then only in that tab
// (sessionStorage, so the room's door passes it on to the classroom page), and only on the online test
// site's own address (*.vercel.app) or on this computer: never on the live site's domain.
// ?zoom-render=off forgets it.
const RENDER_TYPES = { videotag: 1, webgl: 2, webgl2: 3 } as const;
export const ZOOM_RENDER_KEY = "ihear-zoom-render";

export function zoomRenderChoice(): number | null {
  if (typeof window === "undefined") return null;
  const host = window.location.hostname;
  if (!(host.endsWith(".vercel.app") || host === "localhost" || host === "127.0.0.1")) return null;
  try {
    const asked = new URLSearchParams(window.location.search).get("zoom-render");
    if (asked !== null) {
      if (Object.hasOwn(RENDER_TYPES, asked)) window.sessionStorage.setItem(ZOOM_RENDER_KEY, asked);
      else window.sessionStorage.removeItem(ZOOM_RENDER_KEY);
    }
    const kept = window.sessionStorage.getItem(ZOOM_RENDER_KEY);
    return kept !== null && Object.hasOwn(RENDER_TYPES, kept) ? RENDER_TYPES[kept as keyof typeof RENDER_TYPES] : null;
  } catch {
    return null;
  }
}
