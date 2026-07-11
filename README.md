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

`AUTH_SECRET` is required locally and in production. Use a random 32+ character value.

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
window.iHearAuth.isSignedIn()
```

There is no domain allowlist in `auth.js`, so any Google account can sign in once the OAuth consent screen and credentials are configured.

## Inline Editing

Logged-in admins can edit simple text directly on the page. The current admin fallback list is:

```text
sansan20036@gmail.com
shuchen.peng@gmail.com
```

You can override this later with:

```text
AUTH_ADMIN_EMAILS=sansan20036@gmail.com,shuchen.peng@gmail.com
```

Text overrides are read from and written to:

```text
content.json
```

The browser loads saved text from:

```text
/api/content/get
```

Saving posts JSON to:

```text
/api/content/update
```

The update API checks the Auth.js session again on the server before writing. Local filesystem writes work for local development and a persistent Node server. For serverless hosts such as Vercel, filesystem writes are not durable; move the same read/write interface to Supabase or another database before relying on it in production.

## Vercel

Use these settings:

- Framework Preset: `Next.js`
- Build Command: `npm run build`
- Output Directory: leave blank
- Install Command: `npm install`

Add the same Auth.js environment variables in Vercel Project Settings.

Clean URLs such as `/team` are mapped by `next.config.mjs`.
