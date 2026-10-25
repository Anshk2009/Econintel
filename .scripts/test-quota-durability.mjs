// Self-check for the quota counters (functions/chat.js).
// Run: node .scripts/test-quota-durability.mjs
//
// WHY THIS EXISTS
// A rate limit whose counter write gets dropped is not slow — it is absent, on
// an API key shared with live chat. The counters used to be GET -> check ->
// fire-and-forget PUT; that kept writes off the critical path but let a burst of
// parallel requests all read the same count (audit SEC-02). They are now ONE
// awaited TOKENS.incr() each: increment, then compare what it returns.
//
// These assertions pin that shape, so nobody reintroduces a separate read and a
// separate write for a counter (the race) or drops a counter entirely (no limit).
// Source-level; the behaviour itself is covered by test-atomic-quota.mjs.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const raw = readFileSync(new URL('../functions/chat.js', import.meta.url), 'utf8');
const src = raw.replace(/^\s*\/\/.*$/gm, '');   // ignore prose, assert on code

// ── 1. Counters are never read and written separately any more ─────────────
assert.equal([...src.matchAll(/TOKENS\.put\(/g)].length, 0,
  'chat.js must not write counters with TOKENS.put — use TOKENS.incr (atomic)');
assert.equal([...src.matchAll(/TOKENS\.get\(/g)].length, 0,
  'chat.js must not read counters with TOKENS.get — read-then-write is the race');

// ── 2. Every counter still gets incremented, and is awaited ────────────────
for (const key of ['guestKey', 'minuteKey', 'dailyKey', 'freeKey']) {
  assert.ok(src.includes(`await TOKENS.incr(${key},`),
    `${key} must be incremented with an awaited TOKENS.incr — dropping it removes the limit entirely`);
}

// ── 3. Increment-then-check means the comparison is ">" not ">=" ───────────
for (const [v, lim] of [['used', 'GUEST_LIMIT'], ['usedThisMinute', 'plan.queriesPerMinute'],
                        ['usedToday', 'plan.dailyPerIP'], ['usedFree', 'FREE_IP_LIMIT']]) {
  assert.ok(src.includes(`if (${v} > ${lim})`),
    `${v} is the count AFTER this request, so the check must be '${v} > ${lim}' (>= would cut every quota by one)`);
}

// ── 4. The middleware counter falls back instead of throwing ───────────────
const mw = readFileSync(new URL('../functions/middleware.js', import.meta.url), 'utf8');
assert.ok(/async incr\(key, ttlSeconds\)/.test(mw), 'TOKENS.incr must exist in middleware.js');
assert.ok(/res\.status === 404\) kvIncrMissing = true/.test(mw),
  'a missing kv_incr (migration 0013 not applied) must switch to the fallback, not break chat');

// ── 5. Timing is observable ────────────────────────────────────────────────
assert.ok(/'Server-Timing': serverTiming\(\)/.test(src),
  'Server-Timing must be emitted, or the next latency question is guesswork again');
for (const m of ['gate', 'rag', 'upstream']) {
  assert.ok(src.includes(`mark('${m}')`), `missing timing mark: ${m}`);
}

console.log('PASS  quota durability: every counter is one awaited atomic incr');
