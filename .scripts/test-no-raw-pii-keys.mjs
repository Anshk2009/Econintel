// Self-check: kv_store keys never contain a raw IP address or email (auth.js).
// Run: node .scripts/test-no-raw-pii-keys.mjs
//
// WHY THIS EXISTS — audit SEC-08. legal.html tells readers "We store a one-way
// SHA-256 hash, not your raw IP" and "we do not store raw … IP addresses".
// chat.js did hash; auth.js did not — its rate-limit keys were
// rl:signup:<ip>, rl:login:ip:<ip>, rl:login:email:<email>:<ip>,
// rl:login:account:<email>, rl:reset:<email>. A dump of kv_store was a list of
// who signed in from where. Keys now carry hashIP() of each value instead.
import assert from 'node:assert/strict';
import { makeFakeBackend, TEST_ENV, req } from './_fake-backend.mjs';

const { onRequest } = await import('../functions/auth.js');
const hibp = async (url) => (url.hostname === 'api.pwnedpasswords.com' ? new Response('') : null);
const fb = makeFakeBackend({ external: hibp });
globalThis.fetch = fb.fetch;
const call = (path, opts) => onRequest({ env: TEST_ENV, request: req(path, opts) });

const IP = '203.0.113.42';
const EMAIL = 'private.person@example.com';
await call('/auth?action=signup', { method: 'POST', body: { email: EMAIL, password: 'a long enough password', username: 'private' }, ip: IP });
await call('/auth?action=login', { method: 'POST', body: { email: EMAIL, password: 'wrong password!!' }, ip: IP });
await call('/auth?action=login', { method: 'POST', body: { email: EMAIL, password: 'a long enough password' }, ip: IP });
await call('/auth?action=reset-password', { method: 'POST', body: { email: EMAIL }, ip: IP });

const keys = fb.tables.kv_store.map(r => r.key);
assert.ok(keys.some(k => k.startsWith('rl:')), 'no rate-limit rows were written — the test is not exercising anything');
const leaks = keys.filter(k => k.includes(IP) || k.toLowerCase().includes(EMAIL));
assert.deepEqual(leaks, [], 'kv_store keys contain a raw IP or email');

console.log('no raw PII in keys: OK');
