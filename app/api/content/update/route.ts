import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";

// auth.js is intentionally kept at the project root for the existing Auth.js setup.
// @ts-ignore
import { auth } from "../../../../auth.js";
import { isAllowedAdmin, normalizeEmail } from "../../../../lib/admins";
import {
  ContentConflictError,
  publicContentStore,
  updateContentItem,
} from "../../../../lib/content-store";
import { revisionAfterMutation } from "../../../../lib/live-revisions";

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

function isValidExpectedUpdatedAt(value: unknown) {
  return value === null || (typeof value === "string" && !Number.isNaN(Date.parse(value)));
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
    expectedUpdatedAt: string | null;
  }>;

  if (!Object.prototype.hasOwnProperty.call(payload, "expectedUpdatedAt")) {
    return NextResponse.json(
      { error: "Reload the page before editing this content" },
      { status: 428 },
    );
  }

  if (
    !isValidPage(payload.page) ||
    !isValidKey(payload.key) ||
    !isValidValue(payload.value) ||
    !isValidExpectedUpdatedAt(payload.expectedUpdatedAt)
  ) {
    return NextResponse.json(
      { error: "Expected JSON body with page, key, and value strings" },
      { status: 400 },
    );
  }

  try {
    const content = await updateContentItem({
      page: payload.page!.trim(),
      key: payload.key!.trim(),
      value: payload.value,
      updatedBy: email,
      expectedUpdatedAt: payload.expectedUpdatedAt!,
    });
    revalidatePath(payload.page!.trim());
    revalidatePath("/api/content/get");
    revalidatePath("/api/live-revisions");
    const revision = await revisionAfterMutation("content");

    return NextResponse.json({
      ok: true,
      content: publicContentStore(content),
      revision,
    });
  } catch (error) {
    if (error instanceof ContentConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
}
