// Self-check for the rate-limit bucket key (functions/middleware.js getClientIP).
// Run: node .scripts/test-client-ip.mjs
//
// WHY THIS EXISTS — audit SEC-02. Every per-IP limit (guest quota, free-tier
// cap, signup, login) was keyed on the FULL client address. A single home IPv6
// connection is handed a whole /64 — 18 quintillion addresses — so rotating the
// last 64 bits gave an attacker a fresh bucket on every request, enough to drain
// the one NVIDIA key every user shares. One /64 is one customer, so that is the
// bucket. IPv4 is unchanged.
import assert from 'node:assert/strict';
import { makeFakeBackend, TEST_ENV, req, nvidiaStub } from './_fake-backend.mjs';
import { getClientIP } from '../functions/middleware.js';

const ip = (v) => getClientIP(new Request('https://x.test/', { headers: v ? { 'EO-Connecting-IP': v } : {} }));

// ── unit: what the bucket key is ───────────────────────────────────────────
assert.equal(ip('203.0.113.7'), '203.0.113.7', 'IPv4 must be untouched');
assert.equal(ip('::ffff:203.0.113.7'), '203.0.113.7', 'IPv4-mapped IPv6 is the IPv4 address');
assert.equal(ip('2001:db8:1:2:3:4:5:6'), ip('2001:db8:1:2:ffff:ffff:ffff:ffff'), 'same /64 must share a bucket');
assert.equal(ip('2001:db8:1:2::9'), ip('2001:0db8:0001:0002:0:0:0:1'), ':: shorthand and zero-padding must not split a /64');
assert.notEqual(ip('2001:db8:1:2::1'), ip('2001:db8:1:3::1'), 'different /64s are different customers');
assert.equal(ip('2001:DB8:1:2::1'), ip('2001:db8:1:2::1'), 'case must not split a bucket');
assert.equal(ip(null), 'unknown', 'no trusted header -> one shared fail-safe bucket');

// ── integration: the guest quota now holds across a rotating /64 ───────────
const { onRequest } = await import('../functions/chat.js');
const nv = nvidiaStub();
globalThis.fetch = makeFakeBackend({ external: nv.handler, rpc: { match_documents: () => [] } }).fetch;
let last;
for (let i = 1; i <= 6; i++) {
  last = await onRequest({ env: TEST_ENV, request: req('/chat', {
    method: 'POST', body: { messages: [{ role: 'user', content: 'hi' }] }, ip: `2001:db8:aa:bb::${i.toString(16)}` }) });
  if (last.status === 200) await last.text();
}
assert.equal(last.status, 401, `6th guest message from one rotating /64 was allowed (${last.status})`);
assert.equal((await last.json()).code, 'GUEST_QUOTA_EXCEEDED');

console.log('client ip buckets: OK');
