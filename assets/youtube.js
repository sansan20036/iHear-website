/** Parse only supported YouTube URLs; never accept arbitrary embed HTML. */
export function youtubeVideoId(input) {
  if (typeof input !== "string") return null;
  let url;
  try { url = new URL(input.trim()); } catch { return null; }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split('/').filter(Boolean);
  let id = null;
  if (host === 'youtu.be' && parts.length === 1) id = parts[0];
  if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(host)) {
    if (url.pathname === '/watch') id = url.searchParams.get('v');
    else if (parts.length === 2 && ['shorts', 'live', 'embed'].includes(parts[0])) id = parts[1];
  }
  if (['youtube-nocookie.com', 'www.youtube-nocookie.com'].includes(host) && parts.length === 2 && parts[0] === 'embed') id = parts[1];
  return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}
