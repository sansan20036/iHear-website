// A Cloudflare Quick Tunnel to the trial server's PUBLIC port only, restricted to the testers'
// email addresses (Cloudflare sends each visitor a one-time PIN). No Cloudflare account or domain
// is needed; the https://<random>.trycloudflare.com address works only while this runs, and
// stopping it (Ctrl+C) ends access for everyone. Opening a tunnel needs the owner's approval.
// Usage: node tools/classroom-trial/start-tunnel.mjs --allowed-mail tester1@example.org --allowed-mail tester2@example.org
//        [--public-port 3310] [--local-port 3311] [--dry-run]
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
const option = (name) => { const index = argv.indexOf(`--${name}`); return index >= 0 ? argv[index + 1] : undefined; };
const mails = argv.flatMap((value, index) => (value === '--allowed-mail' ? [argv[index + 1]] : []));
const publicPort = Number(option('public-port') ?? 3310);
const localPort = Number(option('local-port') ?? 3311);
const fail = (message) => { console.error(message); process.exit(2); };

if (!mails.length) fail('Name every tester with --allowed-mail <address>; a tunnel without it would be open to anyone.');
if (mails.some(mail => !/^[^\s@,*]+@[^\s@,]+\.[^\s@,]+$/.test(mail ?? ''))) fail('Each --allowed-mail must be one full address (no wildcards, no commas).');
if (!Number.isInteger(publicPort) || publicPort === localPort) fail('The tunnel may point only at the public port, never at the local admin port.');

const command = ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${publicPort}`, ...mails.flatMap(mail => ['--allowed-mail', mail])];
if (argv.includes('--dry-run')) {
  console.log(`cloudflared ${command.join(' ')}`);
  process.exit(0);
}
const tunnel = spawn('cloudflared', command, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
tunnel.on('error', () => fail('cloudflared was not found. Install it from Cloudflare first (and check `cloudflared tunnel --help` lists --allowed-mail).'));
let shown = false;
const watch = (data) => {
  const text = String(data);
  if (/allowed-mail/.test(text) && /flag provided but not defined|unknown flag/i.test(text)) fail('This cloudflared does not know --allowed-mail; update cloudflared. No tunnel was opened.');
  const address = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(text)?.[0];
  if (address && !shown) {
    shown = true;
    console.log(`Tunnel open: ${address} (only ${mails.join(', ')}, after an email PIN)`);
    console.log(`Add lessons with: node tools/classroom-trial/new-lesson.mjs --public ${address} --date YYYY-MM-DD --time HH:MM`);
    console.log('Press Ctrl+C to close the tunnel for everyone.');
  }
};
tunnel.stdout.on('data', watch);
tunnel.stderr.on('data', watch);
tunnel.on('exit', code => { console.log(`Tunnel closed (cloudflared exited ${code}).`); process.exit(code ?? 0); });
process.on('SIGINT', () => tunnel.kill('SIGINT'));
process.on('SIGTERM', () => tunnel.kill('SIGTERM'));
