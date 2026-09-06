import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { GoogleAuth } from "google-auth-library";

const PROJECT_ID = "ihear-website-502118";
const SERVICE_ACCOUNT_EMAIL = "ihear-translation@ihear-website-502118.iam.gserviceaccount.com";
const CONFIG_KEYS = [
  "GOOGLE_CLOUD_PROJECT_ID",
  "GOOGLE_CLOUD_LOCAL_ADC",
  "TRANSLATION_RECEIPT_SECRET",
];
const LEGACY_KEY_NAMES = new Set([
  "GOOGLE_CLOUD_CLIENT_EMAIL",
  "GOOGLE_CLOUD_PRIVATE_KEY",
]);

function usage() {
  console.error(
    "Usage: npm run translation:configure -- --login [--account=owner@example.com] | --check",
  );
}

function envValue(source, key) {
  const line = source
    .split(/\r?\n/)
    .find((item) => new RegExp(`^\\s*${key}\\s*=`).test(item));
  if (!line) return "";
  const raw = line.split("=").slice(1).join("=").trim();
  if (!raw) return "";
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function serializeEnvValue(value) {
  return JSON.stringify(String(value).replace(/\r\n?/g, "\n"));
}

function updateEnv(source) {
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const values = {
    GOOGLE_CLOUD_PROJECT_ID: PROJECT_ID,
    GOOGLE_CLOUD_LOCAL_ADC: "1",
    TRANSLATION_RECEIPT_SECRET:
      envValue(source, "TRANSLATION_RECEIPT_SECRET")
      || randomBytes(48).toString("base64url"),
  };
  const written = new Set();
  const lines = [];

  for (const line of source.split(/\r?\n/)) {
    const key = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/)?.[1];
    if (key && LEGACY_KEY_NAMES.has(key)) continue;
    if (key && CONFIG_KEYS.includes(key)) {
      if (!written.has(key)) lines.push(`${key}=${serializeEnvValue(values[key])}`);
      written.add(key);
      continue;
    }
    lines.push(line);
  }

  if (lines.length && lines.at(-1) !== "") lines.push("");
  if (!CONFIG_KEYS.every((key) => written.has(key))) {
    lines.push("# Server-only Google Cloud Translation local ADC settings.");
    for (const key of CONFIG_KEYS) {
      if (!written.has(key)) lines.push(`${key}=${serializeEnvValue(values[key])}`);
    }
  }
  if (lines.at(-1) !== "") lines.push("");
  return lines.join(newline);
}

function runGcloud(args) {
  const windows = process.platform === "win32";
  const executable = windows ? (process.env.ComSpec || "cmd.exe") : "gcloud";
  const childArgs = windows ? ["/d", "/s", "/c", "gcloud.cmd", ...args] : args;
  return new Promise((resolve, reject) => {
    const child = spawn(executable, childArgs, {
      stdio: "inherit",
      windowsHide: false,
    });
    child.once("error", (error) => {
      reject(new Error(
        error.code === "ENOENT"
          ? "Google Cloud CLI is not installed or is not available in PATH."
          : `Could not start gcloud: ${error.message}`,
      ));
    });
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`gcloud exited with code ${code}`));
    });
  });
}

async function verifyAdc() {
  const auth = new GoogleAuth({
    projectId: PROJECT_ID,
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  const client = await auth.getClient();
  if (client.targetPrincipal !== SERVICE_ACCOUNT_EMAIL) {
    throw new Error(
      `Google ADC is not impersonating the required service account (${SERVICE_ACCOUNT_EMAIL}).`,
    );
  }
  const token = await client.getAccessToken();
  if (!token.token) throw new Error("Google ADC did not return an access token.");
}

async function main() {
  const args = process.argv.slice(2);
  const login = args.includes("--login");
  const check = args.includes("--check");
  const accountArguments = args.filter((argument) => argument.startsWith("--account="));
  const account = accountArguments[0]?.slice("--account=".length).trim() || "";
  if (
    login === check
    || accountArguments.length > 1
    || (account && !/^[^\s@]+@[^\s@]+$/.test(account))
    || (check && account)
    || args.some((argument) => (
      argument !== "--login"
      && argument !== "--check"
      && !argument.startsWith("--account=")
    ))
  ) {
    usage();
    process.exitCode = 1;
    return;
  }

  if (login) {
    await runGcloud([
      "auth",
      "application-default",
      "login",
      ...(account ? [`--account=${account}`] : []),
      `--impersonate-service-account=${SERVICE_ACCOUNT_EMAIL}`,
      `--project=${PROJECT_ID}`,
    ]);
  }
  await verifyAdc();

  if (check) {
    console.log("Short-lived Google ADC is valid. No project files were changed.");
    return;
  }

  const envPath = path.join(process.cwd(), ".env.local");
  let current = "";
  try {
    current = await readFile(envPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await writeFile(envPath, updateEnv(current), { encoding: "utf8", mode: 0o600 });
  console.log("Short-lived Google ADC was verified and enabled for local translation.");
  console.log("Restart npm run dev:local before testing translation.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
