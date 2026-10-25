// Run in the isolated Linux x64 acceptance container, with networking disabled.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const root = process.cwd();
const reportPath = path.join(root, "output", "security-linux-sharp.json");
const report = { test: "linux-native-sharp", status: "running", checks: [] };
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const packageMetadata = async name => JSON.parse(await readFile(path.join(root, "node_modules", name, "package.json"), "utf8"));

try {
  assert.equal(process.platform, "linux", "This acceptance test requires Linux");
  assert.equal(process.arch, "x64", "This acceptance test requires x64");
  const before = process.report.getReport();
  assert.ok(before.header.glibcVersionRuntime, "glibc is required; this is not the musl acceptance target");
  report.runtime = {
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
    glibcRuntime: before.header.glibcVersionRuntime,
    glibcCompiler: before.header.glibcVersionCompiler,
  };
  const [sharpPackage, nativePackage, vipsPackage] = await Promise.all([
    packageMetadata("sharp"),
    packageMetadata("@img/sharp-linux-x64"),
    packageMetadata("@img/sharp-libvips-linux-x64"),
  ]);
  assert.equal(sharpPackage.version, "0.35.5");
  assert.equal(nativePackage.version, "0.35.5");
  assert.equal(vipsPackage.version, "1.3.4");
  report.packages = {
    sharp: sharpPackage.version,
    "@img/sharp-linux-x64": nativePackage.version,
    "@img/sharp-libvips-linux-x64": vipsPackage.version,
  };

  // Loading only sharp is intentional. Explicitly requiring the native add-on
  // here would conceal an accidental WASM fallback in Sharp's own loader.
  const sharp = require("sharp");
  assert.equal(sharp.versions.sharp, "0.35.5");
  assert.equal(sharp.versions.vips, "8.18.7");
  // In 0.35.5 the sharp.node export is an index.cjs loader shim, not the
  // binary. Inspect the cache populated by Sharp itself without requiring
  // either entry here, so these assertions cannot manufacture native loading.
  const exportEntry = require.resolve("@img/sharp-linux-x64/sharp.node");
  const nativePackageRoot = path.join(root, "node_modules", "@img", "sharp-linux-x64");
  const nativeBinary = path.join(nativePackageRoot, "lib", `sharp-linux-x64-${nativePackage.version}.node`);
  assert.equal(path.normalize(exportEntry), path.join(nativePackageRoot, "index.cjs"));
  const loadedNative = Object.keys(require.cache).filter(file => file.endsWith(".node"));
  assert.ok(loadedNative.includes(nativeBinary), "Sharp itself must load the expected versioned linux-x64 native .node add-on");
  const cachedExport = require.cache[exportEntry];
  const cachedBinary = require.cache[nativeBinary];
  assert.ok(cachedExport?.loaded, "Sharp's native export shim must already be loaded");
  assert.ok(cachedBinary?.loaded, "The expected native binary must already be loaded");
  assert.ok(cachedExport.children.some(child => child === cachedBinary && path.normalize(child.filename) === nativeBinary), "The loaded export shim must directly reference the expected cached native binary");
  const loadedWasm = Object.keys(require.cache).filter(file => /[/\\]@img[/\\]sharp-wasm32[/\\]/.test(file) && !file.endsWith("package.json"));
  assert.deepEqual(loadedWasm, [], "The acceptance run must not silently use the WASM fallback");
  const after = process.report.getReport();
  const rawVipsLibraries = after.sharedObjects.filter(file => /libvips/.test(file));
  const vipsLibraries = rawVipsLibraries.map(file => path.normalize(file));
  const expectedVipsLibrary = path.join(root, "node_modules", "@img", "sharp-libvips-linux-x64", "lib", `libvips-cpp.so.${sharp.versions.vips}`);
  assert.ok(vipsLibraries.includes(expectedVipsLibrary), "The process loader must report the expected library inside the packaged Linux libvips directory");
  assert.ok(after.sharedObjects.map(file => path.normalize(file)).includes(nativeBinary), "The process loader must report the same native binary found in the module cache");
  report.loader = {
    exportEntry: path.relative(root, exportEntry),
    exportShimNativeChildren: cachedExport.children.filter(child => child.filename.endsWith(".node")).map(child => path.relative(root, child.filename)),
    nativeBinary: path.relative(root, nativeBinary),
    nativeSha256: digest(await readFile(nativeBinary)),
    loadedNativeModules: loadedNative.map(file => path.relative(root, file)),
    loadedWasmModules: loadedWasm,
    rawLibvipsSharedObjects: rawVipsLibraries,
    libvipsSharedObjects: vipsLibraries.map(file => path.relative(root, file)),
    sharpVersions: sharp.versions,
  };
  report.checks.push("Linux x64/glibc, native add-on, packaged libvips and absence of WASM fallback verified");

  report.imageConversions = [];
  for (const format of ["jpeg", "png"]) {
    const input = await sharp({ create: { width: 96, height: 64, channels: 3, background: "#345a87" } })[format]().toBuffer();
    const inputMetadata = await sharp(input).metadata();
    assert.equal(inputMetadata.format, format);
    const output = await sharp(input, { failOn: "error", limitInputPixels: 40_000_000 })
      .resize({ width: 48, withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
    assert.ok(output.byteLength > 0);
    const metadata = await sharp(output).metadata();
    assert.equal(metadata.format, "webp");
    assert.equal(metadata.width, 48);
    assert.equal(metadata.height, 32);
    const decoded = await sharp(output).raw().toBuffer({ resolveWithObject: true });
    assert.equal(decoded.info.width, 48);
    assert.equal(decoded.info.height, 32);
    assert.equal(decoded.data.byteLength, 48 * 32 * decoded.info.channels);
    report.imageConversions.push({
      inputFormat: format, inputBytes: input.byteLength,
      outputFormat: metadata.format, outputBytes: output.byteLength,
      width: metadata.width, height: metadata.height,
      decodedBytes: decoded.data.byteLength, sha256: digest(output),
    });
  }
  report.checks.push("Benign JPEG and PNG convert to nonempty, fully decodable WebP with expected dimensions");
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = { name: error.name, message: error.message };
  process.exitCode = 1;
} finally {
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Linux native Sharp acceptance: ${report.status}; report: ${path.relative(root, reportPath)}`);
}
