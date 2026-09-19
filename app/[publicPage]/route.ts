import { servePublicPage } from "../../lib/public-page";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ publicPage: string }> }) {
  return servePublicPage(request, `/${(await context.params).publicPage}`);
}
