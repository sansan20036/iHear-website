// The one react-dom call the classroom uses (Classroom 2.0, 2026-11-12: writing names into the video
// tiles the media adapter draws). @types/react-dom is not installed in this project, so this declares
// createPortal as React 19 documents it, and nothing else.
declare module "react-dom" {
  export function createPortal(
    children: import("react").ReactNode,
    container: Element | DocumentFragment,
    key?: string | null,
  ): import("react").ReactPortal;
}
