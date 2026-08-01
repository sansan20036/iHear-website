import type { Metadata } from "next";
import { cookies, headers } from "next/headers";

import AuthErrorClient from "./auth-error-client";

export const metadata: Metadata = {
  title: "Sign-in help | iHear Initiative",
  description: "Recover from an iHear Initiative administrator sign-in problem.",
  robots: {
    index: false,
    follow: false,
    googleBot: { index: false, follow: false },
  },
};

type AuthErrorPageProps = {
  searchParams: Promise<{ error?: string | string[] }>;
};

type Language = "en" | "zhHant" | "zhHans";

function preferredLanguage(cookieLanguage: string | undefined, acceptLanguage: string): Language {
  if (cookieLanguage === "zhTW" || cookieLanguage === "zhHant") return "zhHant";
  if (cookieLanguage === "zhCN" || cookieLanguage === "zhHans") return "zhHans";
  if (cookieLanguage === "en") return "en";

  const normalized = acceptLanguage.toLowerCase();
  if (!normalized.includes("zh")) return "en";
  return /zh-(?:hant|tw|hk|mo)/.test(normalized) ? "zhHant" : "zhHans";
}

export default async function AuthErrorPage({ searchParams }: AuthErrorPageProps) {
  const [params, cookieStore, headerStore] = await Promise.all([searchParams, cookies(), headers()]);
  const rawError = Array.isArray(params.error) ? params.error[0] : params.error;
  const initialLanguage = preferredLanguage(
    cookieStore.get("ihear-lang")?.value,
    headerStore.get("accept-language") || "",
  );

  return <AuthErrorClient error={rawError || "Configuration"} initialLanguage={initialLanguage} />;
}
