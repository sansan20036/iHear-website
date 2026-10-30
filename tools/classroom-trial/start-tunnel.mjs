// A Cloudflare Quick Tunnel to the trial server's PUBLIC port only, restricted to the testers'
// email addresses (Cloudflare sends each visitor a one-time PIN). No Cloudflare account or domain
// is needed; the https://<random>.trycloudflare.com address works only while this runs, and
// stopping it (Ctrl+C) ends access for everyone. Opening a tunnel needs the owner's approval.
//
// Before opening: cloudflared must be 2026.9.2 or later (--allowed-mail), and the port must be the
// trial server's public port (its X-iHear-Trial header says so). After opening: an anonymous
// request must be stopped by Cloudflare's email PIN; if the trial server answers it instead, or
// Cloudflare's answer stays unclear, the tunnel is closed at once.
//
// Usage: node tools/classroom-trial/start-tunnel.mjs --allowed-mail tester1@example.org --allowed-mail tester2@example.org
//        [--public-port 3310] [--local-port 3311] [--cloudflared <path>] [--gate-seconds 90] [--dry-run]
//        node tools/classroom-trial/start-tunnel.mjs --gate-check-only <address>   (only the gate check, no tunnel)
//
// Once a request has been made the process ends by itself rather than through process.exit():
// on Windows, Node can crash when it exits with a connection still open.
import { spawn, spawnSync } from 'node:child_process';
import { get as httpGet } from 'node:http';
import { ALLOWED_MAIL_SINCE, checkGate, cloudflaredPath, newEnough, versionOf } from './tunnel-checks.mjs';

const argv = process.argv.slice(2);
const option = (name) => { const index = argv.indexOf(`--${name}`); return index >= 0 ? argv[index + 1] : undefined; };
const fail = (message, code = 2) => { console.error(message); process.exit(code); };
const gate = async (address) => {
  const { verdict, last } = await checkGate(address, { ms: Number(option('gate-seconds') ?? 90) * 1000 });
  if (verdict === 'gated') console.log(`Email gate confirmed: an anonymous visit was stopped by Cloudflare (${last}); nothing reached this computer.`);
  else if (verdict === 'open') console.error(`GATE FAILED: the trial server answered without an email PIN (${last}).`);
  else console.error(`The email gate could not be confirmed (${last}).`);
  return verdict;
};
const exitCodeOf = verdict => (verdict === 'gated' ? 0 : verdict === 'open' ? 3 : 4);

// The trial server's answer on a port, over a connection that closes after it.
const probePort = port => new Promise(resolve => {
  const sent = httpGet({ host: '127.0.0.1', port, path: '/admin', agent: false }, answer => {
    answer.resume();
    answer.on('end', () => resolve({ status: answer.statusCode, marker: answer.headers['x-ihear-trial'] }));
  });
  sent.on('error', () => resolve(null));
  sent.setTimeout(5000, () => { sent.destroy(); resolve(null); });
});

async function openTunnel() {
  const mails = argv.flatMap((value, index) => (value === '--allowed-mail' ? [argv[index + 1]] : []));
  const publicPort = Number(option('public-port') ?? 3310);
  const localPort = Number(option('local-port') ?? 3311);
  if (!mails.length) fail('Name every tester with --allowed-mail <address>; a tunnel without it would be open to anyone.');
  if (mails.some(mail => !/^[^\s@,*]+@[^\s@,]+\.[^\s@,]+$/.test(mail ?? ''))) fail('Each --allowed-mail must be one full address (no wildcards, no commas).');
  if (!Number.isInteger(publicPort) || publicPort === localPort) fail('The tunnel may point only at the public port, never at the local admin port.');

  const binary = cloudflaredPath(option('cloudflared'));
  const found = spawnSync(binary, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
  const version = found.error ? null : versionOf(`${found.stdout}${found.stderr}`);
  const command = ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${publicPort}`, ...mails.flatMap(mail => ['--allowed-mail', mail])];
  if (argv.includes('--dry-run')) {
    console.log(`cloudflared ${command.join(' ')}`);
    console.log(`cloudflared to run: ${binary} (${version ? `version ${version.join('.')}` : 'not found'})`);
    return;
  }
  if (!version) fail(`cloudflared was not found at ${binary}. Install cloudflared ${ALLOWED_MAIL_SINCE} or later. No tunnel was opened.`);
  if (!newEnough(version)) fail(`cloudflared ${version.join('.')} does not have --allowed-mail; it needs ${ALLOWED_MAIL_SINCE} or later. No tunnel was opened.`);

  // The port must be the trial server's classroom-only public port, not the admin or anything else.
  const probe = await probePort(publicPort);
  if (probe?.status !== 404 || probe.marker !== 'public') {
    fail(`Port ${publicPort} is not the trial server's public port (start tools/classroom-trial/trial-server.mjs first). No tunnel was opened.`);
  }

  const tunnel = spawn(binary, command, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  tunnel.on('error', () => fail(`cloudflared could not be started from ${binary}. No tunnel was opened.`));
  let shown = false;
  // Closing after a failed gate check keeps that failure as the exit code.
  let closing = null;
  const close = (code) => {
    closing = code;
    tunnel.kill('SIGINT');
    setTimeout(() => process.exit(code), 5000).unref();
  };
  const watch = async (data) => {
    const text = String(data);
    if (/allowed-mail/.test(text) && /flag provided but not defined|unknown flag/i.test(text)) fail('This cloudflared does not know --allowed-mail; update cloudflared. No tunnel was opened.');
    const address = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(text)?.[0];
    if (!address || shown) return;
    shown = true;
    console.log(`Tunnel opening: ${address} (only ${mails.join(', ')}, after an email PIN)`);
    console.log('Checking that an anonymous visit is stopped at Cloudflare\'s email PIN…');
    const verdict = await gate(address);
    if (verdict !== 'gated') {
      console.error('Closing the tunnel now.');
      close(exitCodeOf(verdict));
      return;
    }
    console.log(`Add lessons with: node tools/classroom-trial/new-lesson.mjs --public ${address} --date YYYY-MM-DD --time HH:MM`);
    console.log('Press Ctrl+C to close the tunnel for everyone.');
  };
  tunnel.stdout.on('data', data => void watch(data));
  tunnel.stderr.on('data', data => void watch(data));
  tunnel.on('exit', code => {
    console.log(`Tunnel closed (cloudflared exited ${code}).`);
    process.exitCode = closing ?? code ?? 0;
  });
  process.on('SIGINT', () => tunnel.kill('SIGINT'));
  process.on('SIGTERM', () => tunnel.kill('SIGTERM'));
}

if (option('gate-check-only')) process.exitCode = exitCodeOf(await gate(option('gate-check-only')));
else await openTunnel();
