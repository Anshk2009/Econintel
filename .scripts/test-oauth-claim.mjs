// Self-check for OAuth sign-in onto an existing, UNVERIFIED account (auth.js).
// Run: node .scripts/test-oauth-claim.mjs
//
// WHY THIS EXISTS — the audit's SEC-01 "pre-account hijacking":
//   1. An attacker signs up with a password using victim@gmail.com. Nothing ever
//      verifies that email.
//   2. The real owner later clicks "Continue with Google". OAuth finds the row
//      by email and logs them straight into it.
//   3. The attacker still knows the password, so everything the victim types
//      afterwards is readable by the attacker.
// The provider HAS verified the email, so the provider's user is the real owner.
// The fix makes the OAuth login CLAIM the unverified row: the attacker's password
// and every session they hold stop working. These assertions fail if that
// claim step is removed from either provider.
import assert from 'node:assert/strict';
import { makeFakeBackend, TEST_ENV, req, setCookies } from './_fake-backend.mjs';

const { onRequest } = await import('../functions/auth.js');
const VICTIM = 'victim@gmail.com';
const ATTACKER_PASSWORD = 'attacker chose this one';

const env = {
  ...TEST_ENV,
  GOOGLE_CLIENT_ID: 'g-id', GOOGLE_CLIENT_SECRET: 'g-secret',
  DISCORD_CLIENT_ID: 'd-id', DISCORD_CLIENT_SECRET: 'd-secret',
};

// The providers' token + userinfo endpoints, answering as the real owner.
const providers = async (url) => {
  if (url.hostname === 'api.pwnedpasswords.com') return new Response('');
  if (url.href === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'google-at' });
  if (url.href === 'https://openidconnect.googleapis.com/v1/userinfo')
    return Response.json({ email: VICTIM, email_verified: true, given_name: 'Victim' });
  if (url.href === 'https://discord.com/api/oauth2/token') return Response.json({ access_token: 'discord-at' });
  if (url.href === 'https://discord.com/api/users/@me')
    return Response.json({ email: VICTIM, verified: true, username: 'victim' });
  return null;
};

const call = (path, opts) => onRequest({ env, request: req(path, opts) });

// Leg 1 then leg 2 of a provider's redirect flow, exactly as the browser does it.
async function oauthLogin(provider) {
  const leg1 = await call(`/auth?action=oauth-${provider}`);
  assert.equal(leg1.status, 302);
  const state = setCookies(leg1).oauth_state;
  const leg2 = await call(`/auth?action=oauth-${provider}&code=one-time-code&state=${state}`, { cookies: { oauth_state: state } });
  assert.equal(leg2.status, 302);
  assert.match(leg2.headers.get('Location'), /chat\.html\?oauth=1$/, `${provider} login did not complete`);
  return leg2;
}

for (const provider of ['google', 'discord']) {
  const fb = makeFakeBackend({ external: providers });
  globalThis.fetch = fb.fetch;

  // 1. Attacker pre-registers the victim's email with a password they know.
  const signup = await call('/auth?action=signup', { method: 'POST', body: { email: VICTIM, password: ATTACKER_PASSWORD, username: 'squatter' } });
  assert.equal(signup.status, 201);
  const attackerRefresh = setCookies(signup).refresh_token;

  // 2. The real owner signs in with the provider.
  await oauthLogin(provider);

  // 3a. The attacker's password no longer works.
  const pw = await call('/auth?action=login', { method: 'POST', body: { email: VICTIM, password: ATTACKER_PASSWORD }, ip: '192.0.2.200' });
  assert.equal(pw.status, 401, `[${provider}] attacker's password still logs in after the owner claimed the account`);

  // 3b. The attacker's existing session (refresh token) is dead too.
  const refresh = await call('/auth?action=refresh', { method: 'POST', cookies: { refresh_token: attackerRefresh } });
  assert.equal(refresh.status, 401, `[${provider}] attacker's refresh token survived the claim`);

  // 3c. The row is now marked verified, so a second OAuth login is an ordinary one.
  assert.ok(fb.tables.users[0].email_verified_at, `[${provider}] claimed account was not marked verified`);
}

// Control: an account whose email IS verified keeps its password.
{
  const fb = makeFakeBackend({ external: providers });
  globalThis.fetch = fb.fetch;
  await call('/auth?action=signup', { method: 'POST', body: { email: VICTIM, password: ATTACKER_PASSWORD, username: 'owner' } });
  fb.tables.users[0].email_verified_at = '2026-01-01T00:00:00Z';
  await oauthLogin('google');
  const pw = await call('/auth?action=login', { method: 'POST', body: { email: VICTIM, password: ATTACKER_PASSWORD }, ip: '192.0.2.201' });
  assert.equal(pw.status, 200, 'a VERIFIED account lost its password just because the owner also used OAuth');
}

console.log('oauth claim: OK');
