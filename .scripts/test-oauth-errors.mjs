// Self-check: every OAuth failure lands on a page that says what happened (auth.js).
// Run: node .scripts/test-oauth-errors.mjs
//
// These are browser navigations, so each failure must REDIRECT to
// /index.html?oauth_error=<code> (index.html maps the code to a message) — never
// return JSON, never set a session. Pinned for both providers before merging
// their two near-identical handlers into one (audit QA-02).
import assert from 'node:assert/strict';
import { makeFakeBackend, TEST_ENV, req, setCookies } from './_fake-backend.mjs';

const { onRequest } = await import('../functions/auth.js');
const configured = { ...TEST_ENV, GOOGLE_CLIENT_ID: 'g', GOOGLE_CLIENT_SECRET: 'g', DISCORD_CLIENT_ID: 'd', DISCORD_CLIENT_SECRET: 'd' };
let profile = {};
let tokenOk = true;
const ext = async (url) => {
  if (url.href === 'https://oauth2.googleapis.com/token' || url.href === 'https://discord.com/api/oauth2/token')
    return Response.json(tokenOk ? { access_token: 'at' } : { error: 'invalid_grant' });
  if (url.href === 'https://openidconnect.googleapis.com/v1/userinfo' || url.href === 'https://discord.com/api/users/@me') return Response.json(profile);
  return null;
};
const fb = makeFakeBackend({ external: ext });
globalThis.fetch = fb.fetch;
const call = (env, path, opts) => onRequest({ env, request: req(path, opts) });
const errorOf = (res) => { assert.equal(res.status, 302); return new URL(res.headers.get('Location')).searchParams.get('oauth_error'); };

for (const p of ['google', 'discord']) {
  // not configured
  assert.equal(errorOf(await call(TEST_ENV, `/auth?action=oauth-${p}`)), 'not_configured', `${p}: missing client id`);

  // leg 1 sends the browser to the provider with our state + redirect_uri
  const leg1 = await call(configured, `/auth?action=oauth-${p}`);
  const loc = new URL(leg1.headers.get('Location'));
  assert.ok(loc.hostname === (p === 'google' ? 'accounts.google.com' : 'discord.com'), `${p}: leg 1 went to ${loc.hostname}`);
  const state = setCookies(leg1).oauth_state;
  assert.equal(loc.searchParams.get('state'), state, `${p}: state param must equal the oauth_state cookie`);
  assert.equal(loc.searchParams.get('redirect_uri'), `https://econintel.test/auth?action=oauth-${p}`);

  // provider-side cancel / misconfiguration
  assert.equal(errorOf(await call(configured, `/auth?action=oauth-${p}&error=access_denied`)), 'denied');
  assert.equal(errorOf(await call(configured, `/auth?action=oauth-${p}&error=redirect_uri_mismatch`)), 'exchange_failed');

  // forged / replayed state
  assert.equal(errorOf(await call(configured, `/auth?action=oauth-${p}&code=c&state=${state}`)), 'bad_state', `${p}: no state cookie`);
  assert.equal(errorOf(await call(configured, `/auth?action=oauth-${p}&code=c&state=forged`, { cookies: { oauth_state: 'forged' } })), 'bad_state', `${p}: state we never issued`);

  // token exchange fails
  tokenOk = false;
  let l1 = await call(configured, `/auth?action=oauth-${p}`); let st = setCookies(l1).oauth_state;
  assert.equal(errorOf(await call(configured, `/auth?action=oauth-${p}&code=c&state=${st}`, { cookies: { oauth_state: st } })), 'exchange_failed');
  tokenOk = true;

  // provider says the email is NOT verified -> no account, no session
  profile = p === 'google' ? { email: 'x@example.com', email_verified: false } : { email: 'x@example.com', verified: false, username: 'x' };
  l1 = await call(configured, `/auth?action=oauth-${p}`); st = setCookies(l1).oauth_state;
  const unverified = await call(configured, `/auth?action=oauth-${p}&code=c&state=${st}`, { cookies: { oauth_state: st } });
  assert.equal(errorOf(unverified), 'no_verified_email');
  assert.ok(!setCookies(unverified).access_token, `${p}: a session was issued for an unverified email`);

  // a state is single-use: the same callback twice is refused the second time
  profile = p === 'google' ? { email: `${p}@example.com`, email_verified: true, given_name: 'Ok' } : { email: `${p}@example.com`, verified: true, username: 'ok' };
  l1 = await call(configured, `/auth?action=oauth-${p}`); st = setCookies(l1).oauth_state;
  assert.equal(new URL((await call(configured, `/auth?action=oauth-${p}&code=c&state=${st}`, { cookies: { oauth_state: st } })).headers.get('Location')).pathname, '/chat.html');
  assert.equal(errorOf(await call(configured, `/auth?action=oauth-${p}&code=c&state=${st}`, { cookies: { oauth_state: st } })), 'bad_state', `${p}: a used state was accepted again`);
}
assert.equal(fb.tables.users.filter(u => u.email === 'x@example.com').length, 0, 'an account was created for an unverified email');

console.log('oauth errors: OK');
