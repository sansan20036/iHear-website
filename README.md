# iHear Website

Static iHear pages served by Next.js, with Auth.js / NextAuth.js Google sign-in.

## Local Preview

Install dependencies once:

```powershell
npm install
```

Run the Next.js dev server:

```powershell
npm run dev
```

Open:

```text
http://localhost:3000
```

The legacy static server is still available if needed:

```powershell
npm run serve:legacy
```

## Google Sign-In

Auth.js reads these environment variables:

```text
AUTH_SECRET=
AUTH_GOOGLE_ID=
AUTH_GOOGLE_SECRET=
```

Create Google OAuth credentials and add these redirect URIs:

```text
https://ihearprogram.org/api/auth/callback/google
https://i-hear-website.vercel.app/api/auth/callback/google
http://localhost:3000/api/auth/callback/google
```

The front end checks login state through:

```text
/api/auth/session
```

When signed in, the session exposes basic Google profile fields:

```text
session.user.name
session.user.email
session.user.image
```

The nav login widget also exposes:

```text
window.iHearAuth.getSession()
```

## Vercel

Use these settings:

- Framework Preset: `Next.js`
- Build Command: `npm run build`
- Output Directory: leave blank
- Install Command: `npm install`

Add the same Auth.js environment variables in Vercel Project Settings.

Clean URLs such as `/team` are mapped by `next.config.mjs`.
