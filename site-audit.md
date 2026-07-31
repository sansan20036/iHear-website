# iHear Demo Static Site Audit

Source checked: `https://www.ihearus.org/team#main`

## Summary

- The target is a static generated site, not the previous React SPA bundle.
- Sitemap exposes 13 pages.
- Shared styling and interaction code live in `assets/site.css` and `assets/site.js`;
  page-specific admin modules are injected only where their mounts exist.
- Required visual assets are local images under `assets/`.
- The target references `assets/og-image.jpg`, but that file returns 404 on the source site. A local placeholder was created from `assets/logo.png` so the reference does not break locally.

## Mirrored Pages

- `/` -> `index.html`
- `/about` -> `about.html`
- `/programs` -> `programs.html`
- `/impact` -> `impact.html`
- `/team` -> `team.html`
- `/submit-bio` -> `submit-bio.html`
- `/stories` -> `stories.html`
- `/get-involved` -> `get-involved.html`
- `/academy` -> `academy.html`
- `/donate` -> `donate.html`
- `/resources` -> `resources.html`
- `/faq` -> `faq.html`
- `/contact` -> `contact.html`

The `.html` versions work too, for example `/team.html`.

## Mirrored Assets

- `assets/logo.png`
- `assets/og-image.jpg`
- `assets/images/hero-classroom.jpg`
- `assets/images/seminar.jpg`
- `assets/images/tutoring-student.jpg`
- `assets/images/volunteers.jpg`
