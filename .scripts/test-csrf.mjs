// Self-check for CSRF protection on every state-changing endpoint (QA-01).
// Run: node .scripts/test-csrf.mjs
//
// The contract (auth.js validateCSRFToken, chat-history.js handleDeleteHistory):
//   1. the X-CSRF-Token header must equal the csrf_token cookie (double submit)
//   2. the token must have been ISSUED by this server (it is in kv_store)
//   3. it must belong to THIS user — Alice's token cannot authorise Bob's delete
// Characterisation tests: this already holds. Mutation-checked by removing the
// userId comparison (case 3 then fails) — see the commit message.
import assert from 'node:assert/strict';
import { makeFakeBackend, TEST_ENV, req, setCookies } from './_fake-backend.mjs';

const auth = (await import('../functions/auth.js')).onRequest;
const hist = (await import('../functions/chat-history.js')).onRequest;
const hibp = async (url) => (url.hostname === 'api.pwnedpasswords.com' ? new Response('') : null);
const fb = makeFakeBackend({ external: hibp });
globalThis.fetch = fb.fetch;

async function account(name) {
  const r = await auth({ env: TEST_ENV, request: req('/auth?action=signup', { method: 'POST',
    body: { email: `${name}@example.com`, password: 'a long enough password', username: name }, ip: `192.0.2.${name.length}` }) });
  assert.equal(r.status, 201, `signup ${name}`);
  return setCookies(r);
}
const alice = await account('alice');
const bob = await account('bobby');

const endpoints = [
  ['history delete', (c, h) => hist({ env: TEST_ENV, request: req('/chat-history?action=delete', { method: 'DELETE', cookies: c, headers: h }) })],
  ['logout-all',     (c, h) => auth({ env: TEST_ENV, request: req('/auth?action=logout-all', { method: 'POST', cookies: c, headers: h }) })],
  ['delete-account', (c, h) => auth({ env: TEST_ENV, request: req('/auth?action=delete-account', { method: 'POST', cookies: c, headers: h }) })],
];

for (const [name, call] of endpoints) {
  // 1. no header at all
  let r = await call({ access_token: bob.access_token, csrf_token: bob.csrf_token }, {});
  assert.equal(r.status, 403, `${name}: accepted with no X-CSRF-Token header`);
  // 1b. header present but differs from the cookie
  r = await call({ access_token: bob.access_token, csrf_token: bob.csrf_token }, { 'X-CSRF-Token': 'forged-value' });
  assert.equal(r.status, 403, `${name}: accepted a header that does not match the cookie`);
  // 2. matching pair, but never issued by the server
  r = await call({ access_token: bob.access_token, csrf_token: 'made-up' }, { 'X-CSRF-Token': 'made-up' });
  assert.equal(r.status, 403, `${name}: accepted a token the server never issued`);
  // 3. a REAL token — but Alice's, used with Bob's session
  r = await call({ access_token: bob.access_token, csrf_token: alice.csrf_token }, { 'X-CSRF-Token': alice.csrf_token });
  assert.equal(r.status, 403, `${name}: Alice's CSRF token authorised an action on Bob's account`);
}
assert.equal(fb.tables.users.length, 2, 'an account was deleted by a request that should have been refused');

// Control: Bob's own token works.
const ok = await endpoints[0][1]({ access_token: bob.access_token, csrf_token: bob.csrf_token }, { 'X-CSRF-Token': bob.csrf_token });
assert.equal(ok.status, 200, 'a correct CSRF token was refused');

console.log('csrf: OK');
