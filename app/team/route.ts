import { servePublicPage } from "../../lib/public-page";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: Request) {
  const response = await servePublicPage(request, "/team");
  response.cookies.set("ihear-team-access", "", { httpOnly: true, secure: new URL(request.url).protocol === "https:", sameSite: "lax", path: "/", maxAge: 0 });
  return response;
}
