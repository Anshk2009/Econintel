// Self-check for the password-reset endpoints (functions/auth.js).
// Run: node .scripts/test-reset-hardening.mjs
//
// WHY THIS EXISTS — audit SEC-12.
//   1. reset-password was limited per EMAIL only. The email is whatever the
//      caller types, so one client could walk through a list of addresses
//      (an enumeration probe, or a reset-email flood once a real sender is
//      configured) and never hit a limit. Now also 5 per hour per network.
//   2. verify-reset accepted any 12+ character password, including ones in
//      public breach corpora — the HIBP check ran on signup only, so the reset
//      flow was a way around it.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { makeFakeBackend, TEST_ENV, req } from './_fake-backend.mjs';

const { onRequest } = await import('../functions/auth.js');
const BREACHED = 'password1234567';
const sha1 = createHash('sha1').update(BREACHED).digest('hex').toUpperCase();
// HIBP range API: reports BREACHED as pwned, nothing else.
const hibp = async (url) => (url.hostname === 'api.pwnedpasswords.com'
  ? new Response(url.pathname.endsWith(sha1.slice(0, 5)) ? `${sha1.slice(5)}:4242\r\nAAAA:1` : '')
  : null);
const call = (path, opts) => onRequest({ env: TEST_ENV, request: req(path, opts) });

// ── 1. One network cannot walk a list of emails ────────────────────────────
{
  globalThis.fetch = makeFakeBackend({ external: hibp }).fetch;
  const statuses = [];
  for (let i = 0; i < 6; i++) {
    const r = await call('/auth?action=reset-password', { method: 'POST', body: { email: `probe${i}@example.com` }, ip: '203.0.113.99' });
    statuses.push(r.status);
  }
  assert.deepEqual(statuses.slice(0, 5), [200, 200, 200, 200, 200], `normal resets refused: ${statuses}`);
  assert.equal(statuses[5], 429, `6th reset request from one network was not limited: ${statuses}`);
}

// ── 2. A breached password cannot be set through the reset flow ────────────
{
  const fb = makeFakeBackend({ external: hibp });
  globalThis.fetch = fb.fetch;
  await call('/auth?action=signup', { method: 'POST', body: { email: 'r@example.com', password: 'a fine long password', username: 'resetter' }, ip: '192.0.2.3' });
  fb.tables.kv_store.push({ key: 'reset:tok123', value: fb.tables.users[0].id, expires_at: new Date(Date.now() + 3600e3).toISOString() });

  const bad = await call('/auth?action=verify-reset', { method: 'POST', body: { resetToken: 'tok123', newPassword: BREACHED } });
  assert.equal(bad.status, 400, `breached password accepted on reset (${bad.status})`);
  assert.ok(fb.tables.kv_store.some(r => r.key === 'reset:tok123'), 'a refused password must not burn the reset token');

  const good = await call('/auth?action=verify-reset', { method: 'POST', body: { resetToken: 'tok123', newPassword: 'a different good passphrase' } });
  assert.equal(good.status, 200, `a clean password was refused on reset (${good.status})`);
}

console.log('reset hardening: OK');
