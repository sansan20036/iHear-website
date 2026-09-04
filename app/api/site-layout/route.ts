import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
// @ts-ignore
import { auth } from "../../../auth.js";
import { isAllowedAdmin, normalizeEmail } from "../../../lib/admins";
import { revisionAfterMutation } from "../../../lib/live-revisions";
import { isLayoutPage, readSiteLayouts, updateSiteLayout, updateSiteLayouts, validateLayoutConfig } from "../../../lib/site-layout";
import { enforceRateLimit, RATE_LIMIT_POLICIES, withRateLimitHeaders } from "../../../lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
function isSameOrigin(request: Request) { const origin = request.headers.get("origin"); if (!origin) return true; try { return new URL(origin).origin === new URL(request.url).origin; } catch { return false; } }

export async function GET(request: Request) {
  const page = new URL(request.url).searchParams.get("page") || "/";
  if (!isLayoutPage(page)) return NextResponse.json({ error: "Unknown layout page" }, { status: 400 });
  return NextResponse.json({ version: 1, records: await readSiteLayouts(page) }, { headers: { "Cache-Control": "no-store", "Vercel-CDN-Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const session = await auth();
  const email = normalizeEmail(session?.user?.email);
  if (!(await isAllowedAdmin(email))) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const decision = await enforceRateLimit(request, { ...RATE_LIMIT_POLICIES.adminMutation, identifier: email });
  if (decision.limited) return decision.response;
  const respond = <T extends Response>(response: T) => withRateLimitHeaders(response, decision);
  let body: unknown;
  try { body = await request.json(); } catch { return respond(NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })); }
  const payload = body as { page?: unknown; config?: unknown; expectedVersion?: unknown; updates?: unknown };
  const batch = Array.isArray(payload.updates);
  const sources = batch ? payload.updates as Array<{ page?: unknown; config?: unknown; expectedVersion?: unknown }> : [payload];
  if (!sources.length || sources.length > 20) return respond(NextResponse.json({ error: "Invalid layout batch" }, { status: 400 }));
  const updates = [];
  for (const source of sources) {
    if (typeof source.page !== "string" || !isLayoutPage(source.page)) return respond(NextResponse.json({ error: "Unknown layout page" }, { status: 400 }));
    const config = validateLayoutConfig(source.page, source.config);
    const expectedVersion = Number(source.expectedVersion);
    if (!config || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) return respond(NextResponse.json({ error: "Invalid layout fields" }, { status: 400 }));
    updates.push({ page: source.page, config, expectedVersion });
  }
  if (new Set(updates.map((update) => update.page)).size !== updates.length) return respond(NextResponse.json({ error: "Duplicate layout page" }, { status: 400 }));
  try {
    const records = batch
      ? await updateSiteLayouts(updates, email)
      : [await updateSiteLayout(updates[0].page, updates[0].config, updates[0].expectedVersion, email)];
    const paths = new Set(["/api/site-layout", "/api/site-layout/bootstrap", "/api/live-revisions"]);
    for (const update of updates) paths.add(update.page === "/__global__" ? "/" : update.page);
    for (const path of paths) revalidatePath(path);
    const revision = await revisionAfterMutation("layout");
    return respond(NextResponse.json(batch ? { ok: true, records, revision } : { ok: true, record: records[0], revision }));
  } catch (error) {
    if (error instanceof Error && error.message === "conflict") return respond(NextResponse.json({ error: "Layout changed elsewhere" }, { status: 409 }));
    throw error;
  }
}
