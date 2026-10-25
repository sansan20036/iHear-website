// Run only in a disposable Linux container started with --network none.
// IHEAR_SECURITY_ISOLATED=1 is an explicit acknowledgement of this boundary.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = process.cwd();
const require = createRequire(path.join(root, "package.json"));
const reportPath = path.join(root, "output", "security-built-http.json");
const report = { test: "built-next-local-http", status: "running", checks: [], requests: [] };
const dummy = {
  AUTH_SECRET: "security-acceptance-dummy-auth-secret-2026",
  RATE_LIMIT_SECRET: "security-acceptance-dummy-rate-secret-2026",
  TRANSLATION_RECEIPT_SECRET: "security-acceptance-dummy-translation-secret-2026",
  AUTH_GOOGLE_ID: "security-dummy-google-id",
  AUTH_GOOGLE_SECRET: "security-dummy-google-secret",
};
let server;
let serverOutput = "";
let origin;
let snapshotBefore;
const fixturePaths = [];

function assertNoSecrets(text) {
  for (const secret of Object.values(dummy)) assert.ok(!text.includes(secret), "Response or server output exposed a test secret");
  assert.doesNotMatch(text, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|postgres(?:ql)?:\/\/[^\s"<>]+|\b(?:SUPABASE_SERVICE_ROLE_KEY|GOOGLE_CLOUD_PRIVATE_KEY)\s*[=:]\s*\S+/i, "Response or server output exposed credential material");
}

async function packageFromResolvedEntry(entry, expectedName) {
  let directory = path.dirname(entry);
  // Resolve the actual module first, then inspect its own package boundary.
  // Sharp does not export package.json. A root node_modules shortcut could
  // incorrectly report a patched app package while Next resolves a stale one.
  for (let depth = 0; depth < 8; depth += 1) {
    const filename = path.join(directory, "package.json");
    let source;
    try { source = await readFile(filename, "utf8"); } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (source !== undefined) {
      const metadata = JSON.parse(source);
      // An unnamed nested package.json may only establish a module type.
      if (metadata.name !== undefined) {
        assert.equal(metadata.name, expectedName, "Resolved module crossed an unexpected named package boundary");
        assert.equal(typeof metadata.version, "string", "Resolved package must declare its version");
        return { filename, metadata };
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`Could not locate ${expectedName} package metadata within eight ancestors of its resolved entry`);
}

async function snapshotState() {
  const state = {};
  async function visit(relative) {
    const full = path.join(root, relative);
    let info;
    try { info = await lstat(full); } catch (error) {
      if (error.code === "ENOENT") { state[relative] = "absent"; return; }
      throw error;
    }
    assert.ok(!info.isSymbolicLink(), `State path must not be a symlink: ${relative}`);
    if (info.isDirectory()) {
      state[relative] = "directory";
      for (const name of (await readdir(full)).sort()) await visit(path.join(relative, name));
    } else {
      assert.ok(info.isFile(), `Unexpected state entry: ${relative}`);
      state[relative] = createHash("sha256").update(await readFile(full)).digest("hex");
    }
  }
  for (const relative of ["content.json", "data", "public/uploads", "output/security-http-data"]) await visit(relative);
  return state;
}

async function unusedLoopbackPort() {
  const reservation = createServer();
  await new Promise((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const port = reservation.address().port;
  await new Promise((resolve, reject) => {
    reservation.close(error => error ? reject(error) : resolve());
  });
  return port;
}

async function request(label, pathname, expected, options = {}) {
  const url = new URL(pathname, origin);
  assert.equal(url.origin, origin, "Every test request must target the owned loopback server");
  const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(15_000), ...options });
  const bytes = Buffer.from(await response.arrayBuffer());
  const text = bytes.toString("utf8");
  assertNoSecrets(text);
  assert.equal(response.status, expected, `${label}: unexpected HTTP status`);
  report.requests.push({ label, method: options.method || "GET", path: pathname, status: response.status, bytes: bytes.byteLength });
  return { response, text, bytes };
}

async function stopServer() {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  const exited = new Promise(resolve => {
    server.once("exit", resolve);
  });
  server.kill("SIGTERM");
  await Promise.race([exited, delay(5_000)]);
  if (server.exitCode === null && server.signalCode === null) {
    server.kill("SIGKILL");
    await Promise.race([exited, delay(5_000)]);
  }
  assert.ok(server.exitCode !== null || server.signalCode !== null, "Owned Next server did not stop");
}

try {
  assert.equal(process.env.IHEAR_SECURITY_ISOLATED, "1", "Set IHEAR_SECURITY_ISOLATED=1 only inside the disposable --network none container");
  assert.equal(process.platform, "linux", "This guarded HTTP acceptance runner requires the isolated Linux container");
  const externalInterfaces = Object.entries(networkInterfaces()).filter(([, addresses]) => addresses?.some(address => !address.internal)).map(([name]) => name);
  assert.deepEqual(externalInterfaces, [], "Non-loopback network interfaces found; launch the container with --network none");
  const envFiles = (await readdir(root)).filter(name => (name === ".env" || name.startsWith(".env.")) && name !== ".env.example");
  assert.deepEqual(envFiles, [], "Refuse to launch Next while loadable .env files are present (contents were not read)");
  const credentialNames = Object.keys(process.env).filter(name => /^(?:DATABASE_URL|POSTGRES_URL|SUPABASE_.*|GOOGLE_CLOUD_.*|GOOGLE_APPLICATION_CREDENTIALS|VERCEL_.*|NEXT_PUBLIC_SUPABASE_.*)$/.test(name) && process.env[name]);
  assert.deepEqual(credentialNames, [], "Do not pass production/service credential environment variables to the acceptance container");
  assert.ok((await readFile(path.join(root, ".next", "BUILD_ID"), "utf8")).trim(), "A completed production build is required");
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const nextPackagePath = require.resolve("next/package.json");
  const sharpEntry = require.resolve("sharp");
  // Resolve from the optimizer module as well: a nested stale Sharp must not
  // pass just because the app's top-level package has the expected version.
  const optimizerEntry = require.resolve("next/dist/server/image-optimizer/transform.js");
  const nextRequire = createRequire(optimizerEntry);
  const nextSharpEntry = nextRequire.resolve("sharp");
  const [nextPackage, appSharp, optimizerSharp] = await Promise.all([
    readFile(nextPackagePath, "utf8").then(source => JSON.parse(source)),
    packageFromResolvedEntry(sharpEntry, "sharp"),
    packageFromResolvedEntry(nextSharpEntry, "sharp"),
  ]);
  const { filename: sharpPackagePath, metadata: sharpPackage } = appSharp;
  const { filename: nextSharpPackagePath, metadata: nextSharpPackage } = optimizerSharp;
  const sharp = require("sharp");
  report.declaredVersions = { next: packageJson.dependencies.next, sharp: packageJson.dependencies.sharp };
  report.versions = { next: nextPackage.version, sharp: sharpPackage.version, nextOptimizerSharp: nextSharpPackage.version, sharpRuntime: sharp.versions.sharp };
  report.resolvedPackages = { next: path.relative(root, nextPackagePath), sharp: path.relative(root, sharpPackagePath), nextOptimizerSharp: path.relative(root, nextSharpPackagePath) };
  report.resolvedEntries = { sharp: path.relative(root, sharpEntry), nextOptimizer: path.relative(root, optimizerEntry), nextOptimizerSharp: path.relative(root, nextSharpEntry) };
  assert.equal(report.versions.next, "16.4.1", "The installed Next package must be the patched acceptance target");
  assert.equal(report.versions.sharp, "0.35.5", "The installed Sharp package must be the patched acceptance target");
  assert.equal(report.versions.nextOptimizerSharp, "0.35.5", "Next's optimizer must resolve the patched Sharp package");
  assert.equal(report.versions.sharpRuntime, "0.35.5", "The loaded Sharp runtime must match the patched package");
  report.checks.push("Installed Next, app-resolved Sharp, Next-resolved Sharp and loaded Sharp versions match the patched target");
  const marker = `security-optimizer-${randomUUID()}`;
  const svgMarker = `${marker}.svg`;
  const pngMarker = `${marker}.png`;
  const svgSource = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#346"/></svg>';
  const pngSource = await sharp({ create: { width: 800, height: 600, channels: 3, background: "#346789" } }).png().toBuffer();
  // Create both files before Next inventories public/. Only successfully
  // created fixtures belong to this process and may be removed in cleanup.
  for (const [name, bytes] of [[svgMarker, svgSource], [pngMarker, pngSource]]) {
    const fixturePath = path.join(root, "public", name);
    await writeFile(fixturePath, bytes, { flag: "wx" });
    fixturePaths.push(fixturePath);
  }
  snapshotBefore = await snapshotState();
  const port = await unusedLoopbackPort();
  origin = `http://127.0.0.1:${port}`;
  const childEnv = {};
  for (const key of ["PATH", "LANG", "LC_ALL", "TZ", "TMPDIR", "TMP", "TEMP"]) if (process.env[key]) childEnv[key] = process.env[key];
  Object.assign(childEnv, dummy, {
    NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", NO_OPEN: "1",
    IHEAR_FORCE_FILE_STORE: "1", IHEAR_TEST_DATA_DIR: path.join(root, "output/security-http-data"),
    AUTH_OWNER_EMAILS: "security-owner@example.invalid", AUTH_URL: origin,
    VERCEL: "", NETLIFY: "", CONTEXT: "",
  });
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: root, env: childEnv, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  server.on("error", error => { serverOutput += `Spawn error: ${error.message}\n`; });
  server.stdout.on("data", chunk => { serverOutput = (serverOutput + chunk.toString()).slice(-64_000); });
  server.stderr.on("data", chunk => { serverOutput = (serverOutput + chunk.toString()).slice(-64_000); });
  let ready = false;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    assert.equal(server.exitCode, null, "Owned Next server exited during startup");
    try {
      const response = await fetch(`${origin}/api/content/get?page=%2F`, { redirect: "manual", signal: AbortSignal.timeout(1_500) });
      await response.arrayBuffer();
      if (response.status === 200) { ready = true; break; }
    } catch { /* Wait only for our owned loopback server. */ }
    await delay(250);
  }
  assert.ok(ready, "Owned built Next server did not become ready within 60 seconds");
  report.isolation = { platform: process.platform, externalNetworkInterfaces: externalInterfaces, envFiles, forceFileStore: true, testCredentialsOnly: true, ownsServer: true, origin };
  report.checks.push("Only loopback networking, no loadable environment files, dummy credentials and local file stores");

  for (const pathname of ["/", "/team", "/academy", "/api/content/get?page=%2F", "/api/site-media", "/api/media-galleries"]) await request("public read", pathname, 200);
  for (const pathname of ["/api/admin/accounts", "/api/team-profiles?includeDrafts=true", "/api/resources?admin=1", "/api/media-galleries/home?operationId=security-untrusted"]) {
    const result = await request("anonymous protected read", pathname, 403);
    assert.equal(JSON.parse(result.text).error, "Forbidden");
  }
  for (const pathname of ["/api/admin/accounts", "/api/content/update"]) {
    const result = await request("anonymous protected mutation", pathname, 403, {
      method: "POST", headers: { "content-type": "application/json", origin }, body: "{}",
    });
    assert.equal(JSON.parse(result.text).error, "Forbidden");
  }

  const avif = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#346789" } }).avif().toBuffer();
  const sources = [
    ["svg", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>')],
    ["avif", avif],
  ];
  for (const [format, bytes] of sources) {
    for (const pathname of ["/api/site-media/home.hero", "/api/media-galleries/home"]) {
      const form = new FormData();
      form.set("file", new Blob([bytes], { type: "image/webp" }), `${format}-labelled-webp.webp`);
      form.set("expectedVersion", "0");
      form.set("altEn", "Test image"); form.set("altZhHant", "測試圖片"); form.set("altZhHans", "测试图片");
      form.set("focalX", "50"); form.set("focalY", "50"); form.set("zoom", "100");
      const operationId = randomUUID();
      form.set("metadata", JSON.stringify({ operationId, expectedVersion: 0, action: "put", item: { id: operationId, kind: "photo", hidden: false, caption: { en: "", zhHant: "", zhHans: "" } }, alt: { en: "Test image", zhHant: "測試圖片", zhHans: "测试图片" } }));
      const result = await request(`anonymous ${format} upload labelled WebP`, pathname, 403, { method: "POST", headers: { origin }, body: form });
      assert.equal(JSON.parse(result.text).error, "Forbidden", "Authentication rejection must precede image/form validation");
    }
  }
  report.checks.push("Anonymous protected reads/writes and benign SVG/AVIF uploads labelled WebP are rejected with 403 before image validation");

  // v16.4.1 defaults permit width 640 and quality 75. A real resized WebP
  // proves that these parameters, local serving and the optimizer all work;
  // status 200 alone could instead be Next's original-image error fallback.
  // https://github.com/vercel/next.js/blob/v16.4.1/packages/next/src/shared/lib/image-config.ts
  const optimized = await request("local PNG optimizer positive control", `/_next/image?url=${encodeURIComponent(`/${pngMarker}`)}&w=640&q=75`, 200, { headers: { accept: "image/webp" } });
  assert.match(optimized.response.headers.get("content-type") || "", /^image\/webp(?:;|$)/i, "The optimizer must return WebP, not its original PNG fallback");
  assert.ok(optimized.bytes.byteLength > 0, "The optimized image must be nonempty");
  const optimizedMetadata = await sharp(optimized.bytes, { failOn: "error" }).metadata();
  assert.equal(optimizedMetadata.format, "webp");
  assert.equal(optimizedMetadata.width, 640);
  assert.equal(optimizedMetadata.height, 480);
  const decoded = await sharp(optimized.bytes, { failOn: "error" }).raw().toBuffer({ resolveWithObject: true });
  assert.equal(decoded.info.width, 640);
  assert.equal(decoded.info.height, 480);
  assert.equal(decoded.data.byteLength, 640 * 480 * decoded.info.channels);
  report.optimizerPositiveControl = { inputFormat: "png", inputWidth: 800, inputHeight: 600, requestedWidth: 640, quality: 75, contentType: optimized.response.headers.get("content-type"), outputFormat: optimizedMetadata.format, outputWidth: optimizedMetadata.width, outputHeight: optimizedMetadata.height, outputBytes: optimized.bytes.byteLength, decodedBytes: decoded.data.byteLength, sha256: createHash("sha256").update(optimized.bytes).digest("hex") };

  const svgDirect = await request("local SVG fixture is served", `/${svgMarker}`, 200);
  assert.match(svgDirect.response.headers.get("content-type") || "", /^image\/svg\+xml(?:;|$)/i);
  assert.equal(svgDirect.text, svgSource, "The SVG denial test must use the real accessible fixture");
  const remoteDenied = await request("default remote optimizer denial", `/_next/image?url=${encodeURIComponent("https://example.invalid/security.jpg")}&w=640&q=75`, 400);
  assert.equal(remoteDenied.text, '"url" parameter is not allowed', "The remote denial must come from the URL allowlist");
  // This exact error is thrown only after SVG detection and the
  // dangerouslyAllowSVG check; a missing fixture or invalid w/q cannot pass.
  // https://github.com/vercel/next.js/blob/v16.4.1/packages/next/src/server/image-optimizer/transform.ts
  const svgDenied = await request("default SVG optimizer denial", `/_next/image?url=${encodeURIComponent(`/${svgMarker}`)}&w=640&q=75`, 400);
  assert.equal(svgDenied.text, '"url" parameter is valid but image type is not allowed', "The SVG denial must come from the image-type policy");
  report.optimizerDenials = { remote: { status: remoteDenied.response.status, reason: remoteDenied.text }, svg: { directStatus: svgDirect.response.status, directContentType: svgDirect.response.headers.get("content-type"), status: svgDenied.response.status, reason: svgDenied.text } };
  await request("unknown page", "/security-acceptance-not-a-route", 404);
  report.checks.push("Default optimizer returns a fully decoded, resized WebP for a local PNG and rejects remote URLs and accessible SVGs for their specific policy reasons");
  await stopServer();
  assertNoSecrets(serverOutput);
  report.serverOutputSecretScan = "passed";
  const snapshotAfter = await snapshotState();
  assert.deepEqual(snapshotAfter, snapshotBefore, "Protected requests changed local data or upload storage");
  report.stateIntegrity = { unchanged: true, entriesChecked: Object.keys(snapshotBefore).length, snapshotSha256: createHash("sha256").update(JSON.stringify(snapshotBefore)).digest("hex") };
  report.checks.push("No content/data/upload state changed; responses and server output passed secret scan");
  report.limitations = ["403 plus unchanged state verifies the HTTP auth boundary; unit spies separately verify decoder/storage calls are not made.", "This is local acceptance with synthetic credentials, not an OAuth login or production exploitation test."];
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  let message = String(error.message);
  for (const secret of Object.values(dummy)) message = message.replaceAll(secret, "[redacted-test-secret]");
  report.error = { name: error.name, message };
  process.exitCode = 1;
} finally {
  try { await stopServer(); } catch (error) { report.cleanupError = error.message; report.status = "failed"; process.exitCode = 1; }
  if (snapshotBefore && !report.stateIntegrity) {
    try {
      const after = await snapshotState();
      const changedPaths = [...new Set([...Object.keys(snapshotBefore), ...Object.keys(after)])]
        .filter(file => snapshotBefore[file] !== after[file]);
      report.stateIntegrity = { unchanged: changedPaths.length === 0, entriesChecked: Object.keys(snapshotBefore).length, changedPaths };
      if (changedPaths.length) { report.status = "failed"; process.exitCode = 1; }
    } catch (error) { report.stateCheckError = error.message; report.status = "failed"; process.exitCode = 1; }
  }
  for (const fixturePath of fixturePaths) await unlink(fixturePath).catch(error => { if (error.code !== "ENOENT") throw error; });
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Built Next local HTTP acceptance: ${report.status}; report: ${path.relative(root, reportPath)}`);
}
