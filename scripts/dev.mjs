import { spawn } from "node:child_process";
import path from "node:path";

await import("./prepare-public.mjs");

const root = process.cwd();
const nextCli = path.join(root, "node_modules", "next", "dist", "bin", "next");
const args = ["dev", ...process.argv.slice(2)];
let opened = false;

function stripAnsi(value) {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function openBrowser(url) {
  if (process.env.NO_OPEN === "1" || opened) return;
  opened = true;

  const command = process.platform === "win32"
    ? "cmd"
    : process.platform === "darwin"
      ? "open"
      : "xdg-open";
  const openArgs = process.platform === "win32" ? ["/c", "start", "", url] : [url];

  const opener = spawn(command, openArgs, {
    detached: true,
    stdio: "ignore",
  });
  opener.unref();
}

function handleOutput(chunk, stream) {
  const text = chunk.toString();
  stream.write(text);

  const clean = stripAnsi(text);
  const match = clean.match(/Local:\s+(https?:\/\/[^\s]+)/);
  if (match) openBrowser(match[1]);
}

const devServer = spawn(process.execPath, [nextCli, ...args], {
  cwd: root,
  env: process.env,
  stdio: ["inherit", "pipe", "pipe"],
});

devServer.stdout.on("data", (chunk) => handleOutput(chunk, process.stdout));
devServer.stderr.on("data", (chunk) => handleOutput(chunk, process.stderr));

devServer.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});

process.on("SIGINT", () => devServer.kill("SIGINT"));
process.on("SIGTERM", () => devServer.kill("SIGTERM"));
