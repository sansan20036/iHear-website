import { serveAcademyPage } from "../../../../lib/academy-content-page";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const revalidate = 0;

export function GET() { return serveAcademyPage("zhHant"); }
