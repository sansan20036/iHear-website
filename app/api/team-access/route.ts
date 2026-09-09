import { NextResponse } from "next/server";
import { NO_STORE_HEADERS } from "../../../lib/response-headers";
// Visitors with an old password form open can continue to the public page.
export async function POST(request: Request) {
  const response = NextResponse.redirect(new URL("/team", request.url), 303);
  Object.entries(NO_STORE_HEADERS).forEach(([key, value]) => response.headers.set(key, value));
  return response;
}
