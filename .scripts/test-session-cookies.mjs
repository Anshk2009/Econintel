// Self-check: every auth path sets / clears exactly the right cookies (auth.js).
// Run: node .scripts/test-session-cookies.mjs
//
// Pins the Set-Cookie headers byte-for-byte on all paths that issue or end a
// session, so refactoring the copies of this code into one helper (audit QA-02)
// is checked against what browsers actually receive. The attributes matter:
// HttpOnly keeps the tokens away from page scripts, Secure keeps them off plain
// HTTP, SameSite=Strict is the CSRF backstop, and csrf_token is deliberately NOT
// HttpOnly because the page has to read it for the double-submit header.
import assert from 'node:assert/strict';
import { makeFakeBackend, TEST_ENV, req, setCookies } from './_fake-backend.mjs';

const { onRequest } = await import('../functions/auth.js');
const env = { ...TEST_ENV, GOOGLE_CLIENT_ID: 'g', GOOGLE_CLIENT_SECRET: 'g', DISCORD_CLIENT_ID: 'd', DISCORD_CLIENT_SECRET: 'd' };
const ext = async (url) => {
  if (url.hostname === 'api.pwnedpasswords.com') return new Response('');
  if (url.href === 'https://oauth2.googleapis.com/token' || url.href === 'https://discord.com/api/oauth2/token') return Response.json({ access_token: 'at' });
  if (url.href === 'https://openidconnect.googleapis.com/v1/userinfo') return Response.json({ email: 'o@example.com', email_verified: true, given_name: 'Oauthy' });
  if (url.href === 'https://discord.com/api/users/@me') return Response.json({ email: 'd@example.com', verified: true, username: 'discordy' });
  return null;
};
const fb = makeFakeBackend({ external: ext });
globalThis.fetch = fb.fetch;
const call = (path, opts) => onRequest({ env, request: req(path, opts) });

// Raw Set-Cookie values with the random token values blanked, so the exact
// attribute strings can be compared.
const shape = (res) => res.headers.getSetCookie().map(c => c.replace(/^(\w+)=[^;]+;/, '$1=<v>;'));
const ISSUED = [
  'access_token=<v>; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=900',
  'refresh_token=<v>; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000',
  'csrf_token=<v>; Path=/; Secure; SameSite=Strict; Max-Age=86400',
];
const CLEARED = [
  'access_token=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0',
  'refresh_token=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0',
  'csrf_token=; Path=/; Secure; SameSite=Strict; Max-Age=0',
];

const signup = await call('/auth?action=signup', { method: 'POST', body: { email: 'c@example.com', password: 'a long enough password', username: 'cookies' } });
assert.deepEqual(shape(signup), ISSUED, 'signup cookies');
assert.equal(JSON.parse(await signup.clone().text()).csrfToken, setCookies(signup).csrf_token, 'signup: body csrfToken must equal the cookie');

const login = await call('/auth?action=login', { method: 'POST', body: { email: 'c@example.com', password: 'a long enough password' } });
assert.deepEqual(shape(login), ISSUED, 'login cookies');
const c = setCookies(login);

const refresh = await call('/auth?action=refresh', { method: 'POST', cookies: { refresh_token: c.refresh_token } });
assert.deepEqual(shape(refresh), ISSUED, 'refresh cookies');
const r = setCookies(refresh);

fb.tables.kv_store.push({ key: 'reset:t1', value: fb.tables.users[0].id, expires_at: new Date(Date.now() + 3600e3).toISOString() });
const reset = await call('/auth?action=verify-reset', { method: 'POST', body: { resetToken: 't1', newPassword: 'another long passphrase' } });
assert.deepEqual(shape(reset), ISSUED, 'verify-reset cookies');

for (const p of ['google', 'discord']) {
  const leg1 = await call(`/auth?action=oauth-${p}`);
  assert.deepEqual(shape(leg1), ['oauth_state=<v>; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600'], `${p} leg 1`);
  const st = setCookies(leg1).oauth_state;
  const leg2 = await call(`/auth?action=oauth-${p}&code=x&state=${st}`, { cookies: { oauth_state: st } });
  assert.deepEqual(shape(leg2), [...ISSUED, 'oauth_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0'], `${p} leg 2`);
}

// Logout with a REVOKED access token (the reset above bumped token_version).
// Found by this test: handleLogout answered 401 and cleared NOTHING, although
// logout is meant to be idempotent — so after a password reset on another
// device, "Sign out" here left every session cookie in the browser.
const outStale = await call('/auth?action=logout', { method: 'POST', cookies: { access_token: r.access_token, refresh_token: r.refresh_token, csrf_token: r.csrf_token }, headers: { 'X-CSRF-Token': r.csrf_token } });
assert.equal(outStale.status, 200, `logout with a revoked access token answered ${outStale.status}`);
assert.deepEqual(shape(outStale), CLEARED, 'logout with a revoked access token must still clear cookies');

// Ordinary logout with a live session.
const live = setCookies(await call('/auth?action=login', { method: 'POST', body: { email: 'c@example.com', password: 'another long passphrase' }, ip: '198.51.100.31' }));
const out = await call('/auth?action=logout', { method: 'POST', cookies: { access_token: live.access_token, refresh_token: live.refresh_token, csrf_token: live.csrf_token }, headers: { 'X-CSRF-Token': live.csrf_token } });
assert.deepEqual(shape(out), CLEARED, 'logout cookies');
const outNoCsrf = await call('/auth?action=logout', { method: 'POST', cookies: { refresh_token: 'x' } });
assert.deepEqual(shape(outNoCsrf), CLEARED, 'logout without a valid CSRF token still clears cookies');

const s2 = setCookies(await call('/auth?action=login', { method: 'POST', body: { email: 'c@example.com', password: 'another long passphrase' } }));
const del = await call('/auth?action=delete-account', { method: 'POST', cookies: { access_token: s2.access_token, csrf_token: s2.csrf_token }, headers: { 'X-CSRF-Token': s2.csrf_token } });
assert.equal(del.status, 200);
assert.deepEqual(shape(del), CLEARED, 'delete-account cookies');

console.log('session cookies: OK');
