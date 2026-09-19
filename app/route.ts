import { servePublicPage } from "../lib/public-page";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export function GET(request: Request) { return servePublicPage(request, "/"); }
