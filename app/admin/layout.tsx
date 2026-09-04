import type { Metadata } from "next";
import { redirect } from "next/navigation";

// @ts-ignore - auth.js is the existing Auth.js configuration.
import { auth } from "../../auth.js";
import { normalizeEmail, resolveAdminPrincipal } from "../../lib/admins";
import { AdminShell } from "./admin-shell";
import "./admin.css";

export const metadata: Metadata = { title: "iHear Admin" };
export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  const email = normalizeEmail(session?.user?.email);
  if (!email) redirect("/api/auth/signin?callbackUrl=%2Fadmin");
  const principal = await resolveAdminPrincipal(email);
  if (!principal) redirect("/auth-error?error=AccessDenied");
  return <AdminShell principal={{ email: principal.email, role: principal.role }}>{children}</AdminShell>;
}
