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

export async function POST() {
  const response = NextResponse.json({ ok: true });

  for (const name of AUTH_COOKIE_NAMES) {
    for (const path of COOKIE_PATHS) {
      response.cookies.set(name, "", {
        path,
        maxAge: 0,
        expires: new Date(0),
        secure: name.startsWith("__Secure-") || name.startsWith("__Host-"),
        sameSite: "lax",
      });
    }
  }

  return response;
}
