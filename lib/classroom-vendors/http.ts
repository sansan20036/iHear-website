// The one HTTP call the vendor providers make, injectable so tests (and the trial's first dry
// run) can see every request without reaching a vendor.
export type VendorRequest = { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; url: string; headers: Record<string, string>; body?: string };
// `headers` holds the few answer headers the providers read, by lower-case name.
export type VendorResponse = { status: number; body: string; bytes?: Buffer; headers?: Record<string, string> };
export type VendorTransport = (request: VendorRequest) => Promise<VendorResponse>;

// What a download needs to check (Content-Range: which bytes, and the whole file's size) and to
// wait as asked (Retry-After).
const KEPT_HEADERS = ["content-range", "content-length", "retry-after"];

export const fetchTransport: VendorTransport = async ({ method, url, headers, body }) => {
  const response = await fetch(url, { method, headers, body, redirect: "follow", signal: AbortSignal.timeout(15_000) });
  const bytes = Buffer.from(await response.arrayBuffer());
  const kept: Record<string, string> = {};
  for (const name of KEPT_HEADERS) {
    const value = response.headers.get(name);
    if (value != null) kept[name] = value;
  }
  return { status: response.status, body: bytes.toString("utf8"), bytes, headers: kept };
};

/** An answer header by name, or null. */
export const headerOf = (response: VendorResponse, name: string) => response.headers?.[name.toLowerCase()] ?? null;

/** A configured value, or null when the variable is missing or empty. */
export function setting(env: Record<string, string | undefined>, name: string) {
  const value = env[name];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
