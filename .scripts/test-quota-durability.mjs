// Self-check for the quota counters after moving them off the critical path.
// Run: node .scripts/test-quota-durability.mjs
//
// WHY THIS EXISTS
// Awaiting each TOKENS.put put a full HTTPS round trip to Supabase in front of
// the user's answer for a value nobody reads. They now go through
// fireAndForget(). That is a LATENCY win guarding a SECURITY property, which is
// the dangerous combination: if the write is dropped, the counter never
// increments, and a rate limit that never increments is not slow — it is absent,
// on an API key shared with live chat.
//
// EdgeOne does not guarantee context.waitUntil (chat.js tests for it before
// using it on the stream pipe), so the no-waitUntil path MUST still await.
// These assertions pin that. Source-level, because onRequest needs a live
// request/env to invoke.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const raw = readFileSync(new URL('../functions/chat.js', import.meta.url), 'utf8');
const src = raw.replace(/^\s*\/\/.*$/gm, '');   // ignore prose, assert on code

// ── 1. No counter may be written on the critical path any more ─────────────
const bareAwaitedPuts = [...src.matchAll(/await\s+TOKENS\.put\(/g)].length;
assert.equal(bareAwaitedPuts, 0,
  `every TOKENS.put must go through fireAndForget; found ${bareAwaitedPuts} bare awaited put(s)`);

// ── 2. Every counter still gets written ────────────────────────────────────
for (const key of ['guestKey', 'minuteKey', 'dailyKey', 'freeKey']) {
  assert.ok(src.includes(`fireAndForget(TOKENS.put(${key}`),
    `${key} must still be incremented — dropping it removes the limit entirely`);
}

// ── 3. THE SECURITY BRANCH: no waitUntil => must await ─────────────────────
const fn = src.match(/const fireAndForget = \(promise\) => \{[\s\S]*?\n  \};/);
assert.ok(fn, 'fireAndForget must exist');
const body = fn[0];
assert.ok(/typeof context\.waitUntil === 'function'/.test(body),
  'must feature-detect waitUntil rather than assume it');
assert.ok(/return promise;/.test(body),
  'without waitUntil it MUST return the un-swallowed promise so the caller awaits it — ' +
  'otherwise the counter can die with the isolate and the rate limit silently disappears');
assert.ok(/context\.waitUntil\(promise\.catch\(/.test(body),
  'the waitUntil path must swallow rejections, or a failed counter write rejects the request');

// ── 4. Rejections must never be swallowed on the awaited path ──────────────
assert.ok(!/return promise\.catch\(/.test(body),
  'the fallback path must not swallow errors — a failed counter write there should surface');

// ── 5. Timing is observable ────────────────────────────────────────────────
assert.ok(/'Server-Timing': serverTiming\(\)/.test(src),
  'Server-Timing must be emitted, or the next latency question is guesswork again');
for (const m of ['gate', 'rag', 'upstream']) {
  assert.ok(src.includes(`mark('${m}')`), `missing timing mark: ${m}`);
}

console.log('PASS  quota durability: no awaited puts, all counters written, no-waitUntil path still awaits');
