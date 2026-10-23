// Test-only server: runs the built application at its real browser origin and
// applies the checked-in vercel.json response headers to each response, so the
// browser enforces the same framing and content policies. Requests and sessions
// are handled by Next itself. This is not a Vercel deployment test.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import next from 'next';

const port = Number(process.env.ACADEMY_TEST_PORT);
if (!Number.isInteger(port) || port < 1024) throw new Error('ACADEMY_TEST_PORT is required');
const config = JSON.parse(await readFile('vercel.json', 'utf8'));
for (const rule of config.headers) {
  if (rule.source !== '/(.*)' && !/^\/[a-z/]+$/.test(rule.source)) throw new Error('Unsupported header pattern: ' + rule.source);
}

const app = next({ dev: false, dir: process.cwd(), hostname: 'localhost', port });
await app.prepare();
const handle = app.getRequestHandler();
const server = createServer((incoming, outgoing) => {
  const pathname = new URL(incoming.url, `http://localhost:${port}`).pathname;
  // As on Vercel, a later matching rule replaces an earlier rule's header.
  for (const rule of config.headers) {
    if (rule.source !== '/(.*)' && rule.source !== pathname) continue;
    for (const header of rule.headers) outgoing.setHeader(header.key, header.value);
  }
  void handle(incoming, outgoing).catch(error => {
    console.error(error);
    if (!outgoing.headersSent) outgoing.writeHead(500);
    outgoing.end();
  });
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, 'localhost', resolve);
});
console.log(`Built Next header fixture ready at http://localhost:${port}`);
