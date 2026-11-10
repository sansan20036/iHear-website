// Three identities against the built site (2026-11-10): nobody signed in, a person signed in with
// an ordinary Google account, and an administrator. Test-only secret and addresses, disposable
// local storage, the checked-in hosting headers; no production credential, data or request.
// A Google sign-in alone must never reach the admin console or change anything.
import assert from 'node:assert/strict';
import { sessionToken, SESSION_COOKIE, startAcademyServer } from './helpers/academy-smoke.mjs';

const SECRET = 'identity-boundary-test-secret-not-real-0001';
const OWNER = 'owner@example.org';
const VISITOR = 'signed-in-visitor@example.com';
const READS = ['/api/admin/accounts', '/api/admin/activity', '/api/admin/me', '/api/admin/classrooms', '/api/admin/classrooms/blocks', '/api/admin/classrooms/filings', '/api/admin/classrooms/programs', '/api/media-galleries?admin=1'];
const CHANGES = [
  ['POST', '/api/content/update'], ['POST', '/api/site-theme'], ['POST', '/api/site-layout'], ['POST', '/api/team-profiles'],
  ['POST', '/api/impact-milestones'], ['POST', '/api/resources'], ['POST', '/api/resource-topics'], ['POST', '/api/home-calendar'],
  ['POST', '/api/academy-content'], ['POST', '/api/admin/accounts'], ['POST', '/api/admin/classrooms'], ['POST', '/api/admin/classrooms/consents'],
  ['POST', '/api/admin/translations/preview'], ['POST', '/api/media-galleries/TEST-gallery'], ['POST', '/api/site-media/TEST-slot'],
  ['PATCH', '/api/admin/accounts/someone%40example.org'], ['PATCH', '/api/team-profiles/reorder'], ['DELETE', '/api/resources/TEST-resource'],
];

const server = await startAcademyServer({ port: 3219, secret: SECRET, owners: [OWNER], name: 'identity-boundary' });
const results = [];
try {
  const cookieFor = async email => (email ? `${SESSION_COOKIE}=${await sessionToken(SECRET, email)}` : '');
  const identities = [['anonymous', ''], ['ordinary Google account', await cookieFor(VISITOR)], ['administrator', await cookieFor(OWNER)]];
  for (const [name, cookie] of identities) {
    const headers = { ...(cookie ? { cookie } : {}), origin: server.origin };
    for (const route of READS) {
      const response = await fetch(server.origin + route, { headers });
      const text = await response.text();
      if (name === 'administrator') {
        assert.equal(response.status, 200, `${name} reads ${route}`);
      } else {
        assert.ok([401, 403].includes(response.status), `${name} is refused ${route} (got ${response.status})`);
        assert.doesNotMatch(text, new RegExp(OWNER.replace('.', '\\.')), `${name} learns no administrator address from ${route}`);
      }
      results.push(`${name} GET ${route} ${response.status}`);
    }
    if (name === 'administrator') continue; // the administrator's changes are covered by the admin smoke tests
    for (const [method, route] of CHANGES) {
      const response = await fetch(server.origin + route, { method, headers: { ...headers, 'content-type': 'application/json' }, body: '{}' });
      assert.ok([401, 403].includes(response.status), `${name} cannot ${method} ${route} (got ${response.status})`);
      results.push(`${name} ${method} ${route} ${response.status}`);
    }
  }
  // The session says administrator only when the list does: an ordinary account is told so.
  const me = await fetch(`${server.origin}/api/admin/me`, { headers: { cookie: await cookieFor(VISITOR) } });
  assert.equal(me.status, 403);
  assert.equal((await me.json()).code, 'FORBIDDEN');
  // A cross-site request from an administrator's browser is refused too.
  const crossSite = await fetch(`${server.origin}/api/site-theme`, { method: 'POST', headers: { cookie: await cookieFor(OWNER), origin: 'https://attacker.example', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(crossSite.status, 403, 'cross-site change refused even for an administrator');
  console.log(`Identity boundary passed: ${results.length} requests (${READS.length} admin reads × 3 identities, ${CHANGES.length} changes × 2 non-admin identities), an ordinary Google account is refused everything an anonymous visitor is, and a cross-site request from an administrator is refused.`);
} catch (error) {
  console.error(server.logs().slice(-3000));
  throw error;
} finally {
  server.child.kill();
}
