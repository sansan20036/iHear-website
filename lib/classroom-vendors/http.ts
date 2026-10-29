// The one HTTP call the vendor providers make, injectable so tests (and the trial's first dry
// run) can see every request without reaching a vendor.
export type VendorRequest = { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; url: string; headers: Record<string, string>; body?: string };
export type VendorResponse = { status: number; body: string; bytes?: Buffer };
export type VendorTransport = (request: VendorRequest) => Promise<VendorResponse>;

export const fetchTransport: VendorTransport = async ({ method, url, headers, body }) => {
  const response = await fetch(url, { method, headers, body, redirect: "follow", signal: AbortSignal.timeout(15_000) });
  const bytes = Buffer.from(await response.arrayBuffer());
  return { status: response.status, body: bytes.toString("utf8"), bytes };
};

/** A configured value, or null when the variable is missing or empty. */
export function setting(env: Record<string, string | undefined>, name: string) {
  const value = env[name];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
