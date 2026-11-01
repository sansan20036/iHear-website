import { readLayoutBootstrap } from "../../../../lib/site-bootstrap";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Public pages carry this script inline; older page copies still load it here.
export async function GET(request: Request) {
  const body = await readLayoutBootstrap(new URL(request.url).searchParams.get("page") || "/");
  return new Response(body, { headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store", "Vercel-CDN-Cache-Control": "no-store" } });
}
