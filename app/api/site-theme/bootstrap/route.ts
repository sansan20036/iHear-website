import { readThemeBootstrap } from "../../../../lib/site-bootstrap";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Public pages carry this script inline; the React pages and older page copies still load it here.
export async function GET() {
  return new Response(await readThemeBootstrap(), {
    status: 200,
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "no-store",
      "Vercel-CDN-Cache-Control": "no-store",
    },
  });
}
