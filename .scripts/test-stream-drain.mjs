// Self-check for the streaming reveal schedule (chat.html).
// Run: node .scripts/test-stream-drain.mjs
//
// WHY THIS EXISTS
// The reply used to repaint with whatever had arrived on each animation frame,
// which faithfully reproduced the network's burstiness — the text lurched
// forward in clumps and stalled between them. The display is now decoupled from
// arrival: `shownLen` advances on its own clock toward `fullReply.length`.
//
// The step is PROPORTIONAL to the backlog, and that choice is the whole design:
//   - a fixed chars-per-frame rate lags a fast model and stutters on a slow one
//   - a proportional rate drains a burst quickly and a trickle one char at a time
//
// Proportional decay has one classic failure though: it approaches the target
// asymptotically and can take forever to arrive, or with integer truncation
// stall one character short forever. The `Math.max(1, ...)` is what prevents
// that, and it is exactly the kind of guard someone removes while "simplifying".
// These assertions are here to make that removal loud.
//
// The step expression is read out of chat.html rather than restated, so this
// tests the shipped logic and not a copy of it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../chat.html', import.meta.url), 'utf8');

const m = html.match(/shownLen \+= (Math\.max\([^;]+?);/);
assert.ok(m, 'could not find the shownLen step expression in chat.html');
const stepSrc = m[1];

// Rebuild the real step as a function of (fullLen, shownLen).
const step = new Function('fullReply', 'shownLen', `return ${stepSrc};`);
const advance = (fullLen, shown) => {
  let next = shown + step({ length: fullLen }, shown);
  return next > fullLen ? fullLen : next;
};

// ── 1. It always terminates, at every size ───────────────────────────────────
for (const len of [1, 2, 7, 50, 200, 900, 5000]) {
  let shown = 0, frames = 0;
  while (shown < len) {
    const before = shown;
    shown = advance(len, shown);
    assert.ok(shown > before, `stalled at ${before}/${len} — the Math.max(1,…) guard is gone`);
    assert.ok(shown <= len, `overshot: ${shown} > ${len}`);
    assert.ok(++frames < 10000, `did not converge for len=${len}`);
  }
  assert.equal(shown, len);
}

// ── 2. A burst drains fast, so the reveal never lags behind the model ────────
// 200 characters already buffered should clear in well under a second at 60fps.
let shown = 0, frames = 0;
while (shown < 200) { shown = advance(200, shown); frames++; }
assert.ok(frames <= 45, `200-char backlog took ${frames} frames (~${(frames/60).toFixed(2)}s) — too slow`);

// ── 3. A trickle stays smooth rather than jumping ────────────────────────────
// With only a few characters outstanding the step must be small, or a slow
// model reads as a stutter instead of a stream.
assert.equal(advance(3, 0), 1, 'a 3-char backlog should reveal one character');
assert.equal(advance(8, 0), 1, 'an 8-char backlog should reveal one character');

// ── 4. Never exceeds the buffer — a partial markdown slice is fine, a slice
//      past the end would render `undefined` ─────────────────────────────────
for (const [len, at] of [[10, 9], [900, 899], [5, 4]]) {
  assert.ok(advance(len, at) <= len, 'step ran past the end of the buffer');
}

// ── 5. The finalisers must exist, or the reveal outlives the stream ──────────
assert.ok(/cancelAnimationFrame\(drainRAF\)/.test(html), 'drain is never cancelled');
assert.ok(/shownLen = fullReply\.length/.test(html), 'final flush is missing');
// Two finalisers — the normal end of stream, and the network/abort path. Both
// must cancel the drain, or a queued frame repaints a stale slice over the
// finished reply. This counts the cancel rather than the assignment because a
// third `shownLen = fullReply.length` lives inside drain() as an overshoot
// clamp, and counting assignments would make this assertion fail on correct code.
assert.equal((html.match(/cancelAnimationFrame\(drainRAF\)/g) || []).length, 2,
  'both the success path and the error path must cancel the drain');

console.log('✓ stream drain: converges for 7 sizes, 200-char burst clears in '
          + `${frames} frames (~${(frames/60).toFixed(2)}s), trickle reveals 1 char/frame`);
