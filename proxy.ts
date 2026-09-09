import { NextRequest, NextResponse } from "next/server";
import { NO_STORE_HEADERS } from "./lib/response-headers";
export function proxy(request: NextRequest) {
  return NextResponse.rewrite(new URL("/team", request.url), { headers: NO_STORE_HEADERS });
}
export const config = { matcher: ["/team.html"] };
