// Self-check: auth rate limits hold under a parallel burst (functions/auth.js).
// Run: node .scripts/test-auth-atomic.mjs
//
// WHY THIS EXISTS — audit SEC-02, auth side. Signup (3/hour/IP), login lockout
// (5 per IP+email) and reset (3/hour/email) were all checkRateLimit() then, later,
// incrementRateLimit(): a burst fired in parallel all read the same count and all
// passed. For login that meant unlimited password guesses per burst. With the
// atomic kv_incr counter each request takes a distinct slot.
import assert from 'node:assert/strict';
import { makeFakeBackend, TEST_ENV, req } from './_fake-backend.mjs';

const { onRequest } = await import('../functions/auth.js');

// Same contract as the SQL in migration 0013 (one step, no interleaving).
const kv_incr = ({ p_key, p_ttl_seconds }, tables) => {
  const now = new Date().toISOString();
  let row = tables.kv_store.find(r => r.key === p_key);
  if (!row || row.expires_at <= now) {
    tables.kv_store = tables.kv_store.filter(r => r.key !== p_key);
    row = { key: p_key, value: '0', expires_at: new Date(Date.now() + p_ttl_seconds * 1000).toISOString() };
    tables.kv_store.push(row);
  }
  row.value = String(Number(row.value) + 1);
  return Number(row.value);
};
const hibp = async (url) => (url.hostname === 'api.pwnedpasswords.com' ? new Response('') : null);
const call = (path, opts) => onRequest({ env: TEST_ENV, request: req(path, opts) });

function backend() {
  const fb = makeFakeBackend({ external: hibp, rpc: { kv_incr }, latencyMs: 5 });
  globalThis.fetch = fb.fetch;
  return fb;
}

// ── 1. Login: 20 parallel wrong guesses from one IP — only 5 get a real check ──
{
  backend();
  await call('/auth?action=signup', { method: 'POST', body: { email: 'v@example.com', password: 'a long enough password', username: 'victim' }, ip: '192.0.2.1' });
  const rs = await Promise.all(Array.from({ length: 20 }, () =>
    call('/auth?action=login', { method: 'POST', body: { email: 'v@example.com', password: 'wrong guess here' }, ip: '192.0.2.66' })));
  const checked = rs.filter(r => r.status === 401).length;
  assert.ok(checked <= 5, `a parallel burst got ${checked} password checks past a 5-per-IP lockout`);
  assert.ok(checked >= 1, 'no password check ran at all — the test is not exercising login');
}

// ── 2. Signup: 10 parallel signups from one IP — at most 3 accounts ────────
{
  const fb = backend();
  await Promise.all(Array.from({ length: 10 }, (_, i) =>
    call('/auth?action=signup', { method: 'POST', body: { email: `s${i}@example.com`, password: 'a long enough password', username: `signup${i}` }, ip: '192.0.2.77' })));
  assert.ok(fb.tables.users.length <= 3, `a parallel burst created ${fb.tables.users.length} accounts past a 3/hour/IP limit`);
  assert.ok(fb.tables.users.length >= 1, 'no signup succeeded at all — the test is not exercising signup');
}

// ── 3. Reset requests: 10 parallel for one email — at most 3 tokens issued ──
{
  const fb = backend();
  await call('/auth?action=signup', { method: 'POST', body: { email: 'r@example.com', password: 'a long enough password', username: 'resetter' }, ip: '192.0.2.2' });
  await Promise.all(Array.from({ length: 10 }, () =>
    call('/auth?action=reset-password', { method: 'POST', body: { email: 'r@example.com' }, ip: '192.0.2.88' })));
  const tokens = fb.tables.kv_store.filter(r => r.key.startsWith('reset:')).length;
  assert.ok(tokens <= 3, `a parallel burst issued ${tokens} reset tokens past a 3/hour limit`);
  assert.ok(tokens >= 1, 'no reset token was issued at all — the account was probably never created');
}

console.log('auth atomic limits: OK');
