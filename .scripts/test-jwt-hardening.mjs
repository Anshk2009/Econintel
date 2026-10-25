// Self-check for access-token verification (functions/middleware.js verifyJWT).
// Run: node .scripts/test-jwt-hardening.mjs
//
// WHY THIS EXISTS — audit SEC-18. verifyJWT checked expiry with
// `if (payload.exp && payload.exp < now)`, so a correctly signed token with NO
// exp claim was valid forever. Only the server mints tokens today, but any
// future signing bug (or a leaked secret used once) would then mint immortal
// sessions. A token must carry an expiry to be accepted at all.
import assert from 'node:assert/strict';
import { generateJWT, verifyJWT } from '../functions/middleware.js';

const SECRET = 'test-secret-test-secret-test-secret-0123';
const b64url = (s) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
async function sign(header, payload) {
  const msg = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg)));
  return `${msg}.${Buffer.from(sig).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')}`;
}

// A normally minted token still verifies.
const good = await generateJWT({ userId: 'u1', plan: 'free', tv: 1 }, SECRET, 900);
assert.ok(await verifyJWT(good, SECRET), 'a freshly minted token must verify');

// Correctly signed, but no exp claim -> must be refused.
const immortal = await sign({ alg: 'HS256', typ: 'JWT' }, { userId: 'u1', plan: 'free', tv: 1, iat: Math.floor(Date.now() / 1000) });
assert.equal(await verifyJWT(immortal, SECRET), null, 'a signed token without exp was accepted (it would never expire)');

// Expired -> refused (existing behaviour, pinned).
const expired = await generateJWT({ userId: 'u1', tv: 1 }, SECRET, -10);
assert.equal(await verifyJWT(expired, SECRET), null, 'an expired token was accepted');

console.log('jwt hardening: OK');
