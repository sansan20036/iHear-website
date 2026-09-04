import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const TRANSLATION_KEYS = [
  "GOOGLE_CLOUD_PROJECT_ID",
  "GOOGLE_CLOUD_CLIENT_EMAIL",
  "GOOGLE_CLOUD_PRIVATE_KEY",
  "TRANSLATION_RECEIPT_SECRET",
];

function usage() {
  console.error(
    "Usage: npm run translation:configure -- <service-account.json> [--check]",
  );
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function validateCredential(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The selected file is not a Google service-account JSON file.");
  }
  if (value.type !== "service_account") {
    throw new Error("The selected Google credential is not a service account.");
  }
  if (typeof value.project_id !== "string" || !value.project_id.trim()) {
    throw new Error("The service-account JSON is missing project_id.");
  }
  if (
    typeof value.client_email !== "string"
    || !/^[^\s@]+@[^\s@]+\.iam\.gserviceaccount\.com$/i.test(value.client_email)
  ) {
    throw new Error("The service-account JSON has an invalid client_email.");
  }
  if (
    typeof value.private_key !== "string"
    || !value.private_key.includes("-----BEGIN PRIVATE KEY-----")
    || !value.private_key.includes("-----END PRIVATE KEY-----")
  ) {
    throw new Error("The service-account JSON is missing a valid private_key.");
  }
}

function serializeEnvValue(value) {
  return JSON.stringify(String(value).replace(/\r\n?/g, "\n"));
}

function updateEnv(source, values) {
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source ? source.split(/\r?\n/) : [];
  const written = new Set();
  const updated = lines.map((line) => {
    const match = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/);
    const key = match?.[1];
    if (!key || !TRANSLATION_KEYS.includes(key)) return line;
    written.add(key);
    return `${key}=${serializeEnvValue(values[key])}`;
  });

  if (updated.length && updated.at(-1) !== "") updated.push("");
  if (!TRANSLATION_KEYS.every((key) => written.has(key))) {
    updated.push("# Server-only Google Cloud Translation credentials.");
    for (const key of TRANSLATION_KEYS) {
      if (!written.has(key)) updated.push(`${key}=${serializeEnvValue(values[key])}`);
    }
  }
  if (updated.at(-1) !== "") updated.push("");
  return updated.join(newline);
}

async function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes("--check");
  const credentialArgument = args.find((argument) => argument !== "--check");
  if (!credentialArgument) {
    usage();
    process.exitCode = 1;
    return;
  }

  const workspace = process.cwd();
  const credentialPath = path.resolve(credentialArgument);
  if (isInside(workspace, credentialPath)) {
    throw new Error(
      "For safety, keep the downloaded service-account JSON outside the website folder (for example, in Downloads).",
    );
  }

  let credential;
  try {
    credential = JSON.parse(await readFile(credentialPath, "utf8"));
  } catch (error) {
    throw new Error(`Could not read the service-account JSON: ${error.message}`);
  }
  validateCredential(credential);

  if (checkOnly) {
    console.log("Google service-account JSON is valid. No files were changed.");
    return;
  }

  const envPath = path.join(workspace, ".env.local");
  let current = "";
  try {
    current = await readFile(envPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const values = {
    GOOGLE_CLOUD_PROJECT_ID: credential.project_id.trim(),
    GOOGLE_CLOUD_CLIENT_EMAIL: credential.client_email.trim(),
    GOOGLE_CLOUD_PRIVATE_KEY: credential.private_key,
    TRANSLATION_RECEIPT_SECRET: randomBytes(48).toString("base64url"),
  };
  await writeFile(envPath, updateEnv(current, values), { encoding: "utf8", mode: 0o600 });

  console.log("Google Cloud Translation was configured in .env.local.");
  console.log("The private key and receipt secret were not printed.");
  console.log("Restart the local development server before testing translation.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
