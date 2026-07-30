import { NextResponse } from "next/server";
import { revalidatePath, revalidateTag } from "next/cache";

// auth.js is intentionally kept at the project root for the existing Auth.js setup.
// @ts-ignore
import { auth } from "../../../../auth.js";
import { isAllowedAdmin, normalizeEmail } from "../../../../lib/admins";
import {
  CONTENT_CACHE_TAG,
  updateContentItem,
} from "../../../../lib/content-store";

export const dynamic = "force-dynamic";

function isValidPage(value: unknown) {
  return (
    typeof value === "string" &&
    value.startsWith("/") &&
    value.trim().length > 0 &&
    value.length <= 500
  );
}

function isValidKey(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 5000;
}

function isValidValue(value: unknown) {
  return typeof value === "string" && value.length <= 5000;
}

export async function POST(request: Request) {
  const session = await auth();
  const email = normalizeEmail(session?.user?.email);

  if (!isAllowedAdmin(email)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const payload = body as Partial<{
    page: string;
    key: string;
    value: string;
  }>;

  if (!isValidPage(payload.page) || !isValidKey(payload.key) || !isValidValue(payload.value)) {
    return NextResponse.json(
      { error: "Expected JSON body with page, key, and value strings" },
      { status: 400 },
    );
  }

  const content = await updateContentItem({
    page: payload.page!.trim(),
    key: payload.key!.trim(),
    value: payload.value,
    updatedBy: email,
  });
  revalidateTag(CONTENT_CACHE_TAG, { expire: 0 });
  revalidatePath(payload.page!.trim());
  revalidatePath("/api/content/get");

  return NextResponse.json({
    ok: true,
    content,
  });
}
