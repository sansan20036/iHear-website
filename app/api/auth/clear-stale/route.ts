import { NextResponse } from "next/server";

const AUTH_COOKIE_NAMES = [
  "authjs.csrf-token",
  "authjs.callback-url",
  "authjs.pkce.code_verifier",
  "authjs.state",
  "authjs.nonce",
  "next-auth.csrf-token",
  "next-auth.callback-url",
  "next-auth.pkce.code_verifier",
  "next-auth.state",
  "next-auth.nonce",
  "__Host-authjs.csrf-token",
  "__Secure-authjs.callback-url",
  "__Secure-authjs.pkce.code_verifier",
  "__Secure-authjs.state",
  "__Secure-authjs.nonce",
  "__Host-next-auth.csrf-token",
  "__Secure-next-auth.callback-url",
  "__Secure-next-auth.pkce.code_verifier",
  "__Secure-next-auth.state",
  "__Secure-next-auth.nonce",
];

const COOKIE_PATHS = ["/", "/api/auth"];

function expiredCookie(name: string, path: string) {
  const attributes = [
    `${name}=`,
    `Path=${path}`,
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    "Max-Age=0",
    "SameSite=Lax",
  ];
  if (name.startsWith("__Secure-") || name.startsWith("__Host-")) {
    attributes.push("Secure");
  }
  return attributes.join("; ");
}

export async function POST() {
  const response = NextResponse.json({ ok: true });

  for (const name of AUTH_COOKIE_NAMES) {
    // __Host- cookies are only valid with Path=/; all other legacy and current
    // Auth.js cookies may exist at either path and must be expired separately.
    const paths = name.startsWith("__Host-") ? ["/"] : COOKIE_PATHS;
    for (const path of paths) {
      response.headers.append("Set-Cookie", expiredCookie(name, path));
    }
  }

  return response;
}
