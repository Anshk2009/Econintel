// Self-check: deleting an account leaves nothing in kv_store that names it.
// Run: node .scripts/test-delete-account.mjs
//
// WHY THIS EXISTS — audit SEC-15. delete-account removed the users row (and,
// by cascade, chat_history) plus THIS browser's refresh token. Everything else
// keyed on the person stayed behind: their email in rate-limit keys
// (rl:login:email:<email>:<ip>, rl:login:account:<email>, rl:reset:<email>),
// their userId in chat counters and in every other device's refresh/CSRF rows.
// Under the DPDP Act erasure means the data, not just the profile row.
import assert from 'node:assert/strict';
import { makeFakeBackend, TEST_ENV, req, setCookies } from './_fake-backend.mjs';

const { onRequest } = await import('../functions/auth.js');
const hibp = async (url) => (url.hostname === 'api.pwnedpasswords.com' ? new Response('') : null);
const call = (path, opts) => onRequest({ env: TEST_ENV, request: req(path, opts) });

const fb = makeFakeBackend({ external: hibp });
globalThis.fetch = fb.fetch;
const EMAIL = 'leaving@example.com';
const PASSWORD = 'a long enough password';

const signup = await call('/auth?action=signup', { method: 'POST', body: { email: EMAIL, password: PASSWORD, username: 'leaving' } });
assert.equal(signup.status, 201);
const userId = fb.tables.users[0].id;

// A second device's session, a failed login, a reset request, and a chat
// counter — the kinds of rows real use leaves behind.
await call('/auth?action=login', { method: 'POST', body: { email: EMAIL, password: PASSWORD }, ip: '198.51.100.20' });
await call('/auth?action=login', { method: 'POST', body: { email: EMAIL, password: 'wrong password!' }, ip: '198.51.100.21' });
await call('/auth?action=reset-password', { method: 'POST', body: { email: EMAIL } });
fb.tables.kv_store.push({ key: `chat:rl:auth:user:${userId}:2026-10-26`, value: '3', expires_at: new Date(Date.now() + 86400e3).toISOString() });
// Someone else's rows, which must survive.
fb.tables.kv_store.push({ key: 'rl:login:account:someone@else.com', value: '1', expires_at: new Date(Date.now() + 3600e3).toISOString() });

const c = setCookies(signup);
const del = await call('/auth?action=delete-account', { method: 'POST',
  cookies: { access_token: c.access_token, refresh_token: c.refresh_token, csrf_token: c.csrf_token },
  headers: { 'X-CSRF-Token': c.csrf_token } });
assert.equal(del.status, 200, `delete-account failed (${del.status})`);
assert.equal(fb.tables.users.length, 0, 'users row survived');

const left = fb.tables.kv_store.filter(r => r.key.includes(EMAIL) || r.key.includes(userId) || r.value.includes(userId));
assert.deepEqual(left.map(r => r.key), [], 'kv_store still holds rows naming the deleted account');
assert.ok(fb.tables.kv_store.some(r => r.key === 'rl:login:account:someone@else.com'), "another user's row was deleted");

console.log('delete account: OK');
