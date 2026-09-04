export async function adminFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: "same-origin",
    cache: "no-store",
    ...init,
    headers: init?.body instanceof FormData ? init.headers : { "Content-Type": "application/json", ...init?.headers },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `Request failed (${response.status})`) as Error & { status?: number; issues?: Record<string, string> };
    error.status = response.status;
    error.issues = data.issues;
    throw error;
  }
  return data as T;
}

export function displayError(error: unknown, locale: "en" | "zhHant" | "zhHans") {
  const status = (error as { status?: number })?.status;
  if (status === 409) return locale === "en" ? "Someone changed this record. Your draft is kept; reload before saving." : locale === "zhHans" ? "其他管理员已更改此资料。草稿已保留，请重新加载后再保存。" : "其他管理員已更改此資料。草稿已保留，請重新載入後再儲存。";
  if (status === 403) return locale === "en" ? "Your administrator access has expired." : locale === "zhHans" ? "您的管理员权限已失效。" : "您的管理員權限已失效。";
  return (error as Error)?.message || (locale === "en" ? "Something went wrong." : locale === "zhHans" ? "发生错误，请再试一次。" : "發生錯誤，請再試一次。");
}
