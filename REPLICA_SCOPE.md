# Current Replica Scope

The active interface is now the static site from `https://ihearprogram.org/`.

## Current Frontend

- 13 static HTML pages are mirrored locally.
- Shared images are mirrored under `assets/`.
- `server.js` supports both `.html` paths and clean paths like `/team`.

## Local Backend Note

The local API/admin sandbox from the earlier React mirror still exists in `server.js` and `data/db.json`. The new target static pages do not require it for basic viewing.

Default local admin password remains:

```text
ihear-admin-local
```

## Start

```powershell
cd "C:\Users\sansa\OneDrive\桌面\iHear website"
npm start
```
