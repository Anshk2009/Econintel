// Self-check: revoking sessions actually revokes them (QA-01).
// Run: node .scripts/test-session-revocation.mjs
//
// The contract (users.token_version, checked by verifyJWT's dbCheck on every
// request and by handleRefreshToken):
//   - logout-all  -> every access token AND refresh token issued before it dies
//   - password reset -> the same, so a stolen session cannot outlive the reset
//   - logout       -> that access token is blacklisted, its refresh token deleted
// Characterisation tests: this already holds. Mutation-checked by making dbCheck
// always return true (the logout-all case then fails).
import assert from 'node:assert/strict';
import { makeFakeBackend, TEST_ENV, req, setCookies } from './_fake-backend.mjs';

const auth = (await import('../functions/auth.js')).onRequest;
const hist = (await import('../functions/chat-history.js')).onRequest;
const hibp = async (url) => (url.hostname === 'api.pwnedpasswords.com' ? new Response('') : null);
const call = (fn, path, opts) => fn({ env: TEST_ENV, request: req(path, opts) });
const PW = 'a long enough password';

async function fresh() {
  const fb = makeFakeBackend({ external: hibp });
  globalThis.fetch = fb.fetch;
  const r = await call(auth, '/auth?action=signup', { method: 'POST', body: { email: 's@example.com', password: PW, username: 'session' } });
  assert.equal(r.status, 201);
  return { fb, c: setCookies(r) };
}
const canRead = async (c) => (await call(hist, '/chat-history?action=get', { cookies: { access_token: c.access_token } })).status === 200;
const canRefresh = async (c) => (await call(auth, '/auth?action=refresh', { method: 'POST', cookies: { refresh_token: c.refresh_token } })).status === 200;

// ── logout-all kills every older session (here: a second device) ───────────
{
  const { c: device1 } = await fresh();
  // Wait past the second boundary: tokens minted in the same second with the
  // same claims are byte-identical, so the blacklist of device1's token would
  // also kill device2's and this case would never exercise token_version.
  await new Promise(r => setTimeout(r, 1100));
  const device2 = setCookies(await call(auth, '/auth?action=login', { method: 'POST', body: { email: 's@example.com', password: PW }, ip: '198.51.100.2' }));
  assert.ok(await canRead(device2) && await canRead(device1), 'precondition: both sessions work');
  const out = await call(auth, '/auth?action=logout-all', { method: 'POST',
    cookies: { access_token: device1.access_token, csrf_token: device1.csrf_token }, headers: { 'X-CSRF-Token': device1.csrf_token } });
  assert.equal(out.status, 200);
  assert.equal(await canRead(device2), false, 'logout-all: the other device\'s access token still works');
  assert.equal(await canRefresh(device2), false, 'logout-all: the other device can still mint new tokens');
}

// ── a password reset kills the sessions that existed before it ─────────────
{
  const { fb, c: thief } = await fresh();
  fb.tables.kv_store.push({ key: 'reset:tok', value: fb.tables.users[0].id, expires_at: new Date(Date.now() + 3600e3).toISOString() });
  const r = await call(auth, '/auth?action=verify-reset', { method: 'POST', body: { resetToken: 'tok', newPassword: 'a brand new passphrase' } });
  assert.equal(r.status, 200);
  assert.equal(await canRead(thief), false, 'reset: an access token from before the reset still works');
  assert.equal(await canRefresh(thief), false, 'reset: a refresh token from before the reset still works');
}

// ── logout ends this session ───────────────────────────────────────────────
{
  const { c } = await fresh();
  const out = await call(auth, '/auth?action=logout', { method: 'POST',
    cookies: { access_token: c.access_token, refresh_token: c.refresh_token, csrf_token: c.csrf_token }, headers: { 'X-CSRF-Token': c.csrf_token } });
  assert.equal(out.status, 200);
  assert.equal(await canRead(c), false, 'logout: the access token still works');
  assert.equal(await canRefresh(c), false, 'logout: the refresh token still works');
}

console.log('session revocation: OK');
