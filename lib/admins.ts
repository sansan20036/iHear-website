import { findAdminAccount } from "./admin-store";

const DEFAULT_OWNERS = [
    "sansan20036@gmail.com",
    "shuchen.peng@gmail.com",
    "ihearprogram@gmail.com",
];

export const OWNER_ADMINS = (
  process.env.AUTH_OWNER_EMAILS?.split(",") ??
  process.env.AUTH_ADMIN_EMAILS?.split(",") ??
  DEFAULT_OWNERS
)
  .map((email) => email.trim().toLowerCase())
  .filter(Boolean);

// Kept for older imports and operational checks.
export const ALLOWED_ADMINS = OWNER_ADMINS;

export function normalizeEmail(email: unknown) {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

export type AdminPrincipal = {
  email: string;
  role: "owner" | "editor";
  source: "environment" | "database";
};

export function isOwnerAdmin(email: unknown) {
  return OWNER_ADMINS.includes(normalizeEmail(email));
}

export async function resolveAdminPrincipal(email: unknown): Promise<AdminPrincipal | null> {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  if (isOwnerAdmin(normalized)) {
    return { email: normalized, role: "owner", source: "environment" };
  }
  const account = await findAdminAccount(normalized);
  if (!account?.enabled) return null;
  return { email: normalized, role: "editor", source: "database" };
}

export async function isAllowedAdmin(email: unknown) {
  return Boolean(await resolveAdminPrincipal(email));
}
