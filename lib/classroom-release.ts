// The online classroom's release name (2026-11-14): the only place it is written. It is not shown on
// screen (the owner's call, 2026-11-14); the lobby's pages carry the version as data-classroom-release,
// so anyone can still see which release a page comes from. It names the product only: it is not an API, a data, a consent
// or a backup version (those keep their own), and it holds nothing about anyone.
export const CLASSROOM_RELEASE = Object.freeze({
  version: "2.1",
  label: "Classroom 2.1",
  name: "Pre-Class Experience Update",
});

// "Classroom 2.1 — Pre-Class Experience Update": for release notes and reports.
export const CLASSROOM_RELEASE_FULL_NAME = `${CLASSROOM_RELEASE.label} — ${CLASSROOM_RELEASE.name}`;
