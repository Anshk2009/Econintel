// Self-check for the login lockout (functions/auth.js handleLogin).
// Run: node .scripts/test-login-lockout.mjs
//
// WHY THIS EXISTS
// The audit (SEC-04) found the "account temporarily locked" check sat INSIDE the
// wrong-password branch. A locked account therefore still logged in the moment
// the attacker guessed right — the lock changed the error message for wrong
// guesses and did nothing else. These assertions fail if the lock check ever
// moves back behind the password comparison.
import assert from 'node:assert/strict';
import { makeFakeBackend, TEST_ENV, req } from './_fake-backend.mjs';

// HIBP is called on signup; answer "not breached" so signup succeeds.
const hibp = async (url) => (url.hostname === 'api.pwnedpasswords.com' ? new Response('') : null);
const { onRequest } = await import('../functions/auth.js');

const EMAIL = 'victim@example.com';
const PASSWORD = 'correct horse battery staple';

async function freshAccount() {
  const fb = makeFakeBackend({ external: hibp });
  globalThis.fetch = fb.fetch;
  const r = await onRequest({ env: TEST_ENV, request: req('/auth?action=signup', {
    method: 'POST', body: { email: EMAIL, password: PASSWORD, username: 'victim' }, ip: '198.51.100.1' }) });
  assert.equal(r.status, 201, 'signup should succeed');
  return fb;
}
const login = (password, ip) => onRequest({ env: TEST_ENV, request: req('/auth?action=login', {
  method: 'POST', body: { email: EMAIL, password }, ip }) });

// ── 1. Same IP: after 5 wrong guesses, the RIGHT password is still refused ──
{
  await freshAccount();
  for (let i = 0; i < 5; i++) await login('wrong password guess', '203.0.113.9');
  const r = await login(PASSWORD, '203.0.113.9');
  assert.equal(r.status, 429, `locked account logged in with the right password (got ${r.status})`);
}

// ── 2. Spread across IPs: the per-ACCOUNT cap still stops the right guess ──
// Each attacker IP stays under its own per-IP limits; only an account-wide
// counter can see the pattern.
{
  await freshAccount();
  for (let i = 0; i < 30; i++) await login('wrong password guess', `2001:db8:${i.toString(16)}::1`);
  const r = await login(PASSWORD, '2001:db8:ffff::1');
  assert.equal(r.status, 429, `distributed guessing was not capped per account (got ${r.status})`);
}

// ── 3. Control: a normal user with one typo still gets in ──────────────────
{
  await freshAccount();
  await login('typo', '203.0.113.50');
  const r = await login(PASSWORD, '203.0.113.50');
  assert.equal(r.status, 200, `legitimate login after one typo was refused (got ${r.status})`);
}

console.log('login lockout: OK');
