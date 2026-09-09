# Team page access

The password gate was removed on 2026-09-09 at the site owner's request.
The team page, published profiles, content and photos are public. Refresh and
history navigation no longer install a password gate. Old form submissions
redirect to /team. Existing team cookies are cleared and ignored, and the old
password environment variables are no longer used.

Admin mutations, draft and deleted profile reads retain existing authorization.
No database content or storage objects are changed by this update. The image
bucket remains private and the existing image API serves public photo bytes.
The generated .private/team.html file is traced with the /team server function.
Deploy only the application; no data import, migration or storage change is needed.

Image URLs include the unique uploaded object path as an `asset` parameter.
Matching successful responses cache publicly in the browser and Vercel CDN for
one year. Replacements use a new object path, so they get a fresh cache entry even
when a deleted slot is recreated with the same row version. Stale object keys,
missing images and legacy URLs without an object key remain uncached. The media
metadata API retains no-store so editor changes update displayed URLs immediately.
