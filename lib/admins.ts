export const ALLOWED_ADMINS = (
  process.env.AUTH_ADMIN_EMAILS?.split(",") ?? [
    "sansan20036@gmail.com",
    "shuchen.peng@gmail.com",
    "ihearprogram@gmail.com",
  ]
)
  .map((email) => email.trim().toLowerCase())
  .filter(Boolean);

export function normalizeEmail(email: unknown) {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

export function isAllowedAdmin(email: unknown) {
  return ALLOWED_ADMINS.includes(normalizeEmail(email));
}
