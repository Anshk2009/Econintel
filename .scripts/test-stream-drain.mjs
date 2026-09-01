// Self-check for the streaming reveal (chat.html).
// Run: node .scripts/test-stream-drain.mjs
//
// WHY THIS EXISTS
// Tokens do not arrive evenly. Painting whatever had arrived on each animation
// frame reproduced that burstiness exactly — the text lurched and stalled. The
// display is now decoupled from arrival: `shownLen` advances on its own clock,
// at a rate that is EASED toward what the backlog demands rather than snapped
// to it.
//
// Two guards in that loop are load-bearing and both look like noise to someone
// tidying up. These assertions exist to make removing either one loud:
//
//   Math.max(1, …)  — an eased rate approaches its target asymptotically and
//                     rounds to 0 while characters are still outstanding. Without
//                     this the reveal stalls permanently, mid-reply.
//   Math.min(backlog, …) — without it the slice runs past the end of the buffer.
//
// The tuning constants are read out of chat.html rather than restated, so this
// tests the shipped numbers and not a copy of them.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../chat.html', import.meta.url), 'utf8');

const divisor = Number((html.match(/const target = backlog \/ (\d+(?:\.\d+)?);/) || [])[1]);
const alpha   = Number((html.match(/revealRate \+= \(target - revealRate\) \* (\d*\.?\d+);/) || [])[1]);
assert.ok(divisor > 0, 'could not find the backlog divisor in chat.html');
assert.ok(alpha > 0 && alpha <= 1, 'could not find the easing factor in chat.html');
assert.ok(/Math\.max\(1,/.test(html), 'the Math.max(1, …) anti-stall guard is gone');
assert.ok(/Math\.min\(backlog,/.test(html), 'the Math.min(backlog, …) overshoot guard is gone');

// Re-create the shipped loop using those constants.
function reveal(arrivals) {
  let arrived = 0, shown = 0, rate = 0;
  const perFrame = [];
  for (let f = 0; f < arrivals.length; f++) {
    arrived += arrivals[f];
    const backlog = arrived - shown;
    let d = 0;
    if (backlog > 0) {
      rate += (backlog / divisor - rate) * alpha;
      d = Math.min(backlog, Math.max(1, Math.round(rate)));
      shown += d;
      assert.ok(d >= 1, 'stalled: revealed 0 characters with a non-empty backlog');
      assert.ok(shown <= arrived, `overshot the buffer: ${shown} > ${arrived}`);
    }
    perFrame.push(d);
  }
  return { shown, arrived, perFrame };
}

// ── 1. Always terminates, at every reply size ────────────────────────────────
for (const len of [1, 2, 7, 50, 200, 900, 4000]) {
  // everything arrives at once, then idle frames — the worst case for an
  // asymptotic rate, because the backlog only ever shrinks
  const r = reveal([len, ...Array(4000).fill(0)]);
  assert.equal(r.shown, len, `did not finish revealing ${len} chars`);
}

// ── 2. A burst clears fast enough not to feel laggy ──────────────────────────
let frames = 0;
{
  let arrived = 200, shown = 0, rate = 0;
  while (shown < arrived) {
    rate += ((arrived - shown) / divisor - rate) * alpha;
    shown += Math.min(arrived - shown, Math.max(1, Math.round(rate)));
    frames++;
    assert.ok(frames < 5000, 'never converged');
  }
  assert.ok(frames <= 90, `200-char burst took ${frames} frames (~${(frames/60).toFixed(2)}s)`);
}

// ── 3. THE POINT: the rate ramps, it does not sawtooth ───────────────────────
// Jerk = mean absolute change in chars revealed between consecutive frames.
// Standard deviation is deliberately NOT used: a smooth ramp from 1 to 10 has
// the same spread as a sawtooth oscillating between them, so SD cannot tell
// them apart. Jerk can.
const bursts = [0,0,34,0,0,0,52,0,0,0,0,41,0,0,7,0,0,0,63,0,0,0,0,0,28,0,0,0,0,0,0,0,0,0,0,0];
const { perFrame } = reveal(bursts);
const jerk = arr => {
  let s = 0;
  for (let i = 1; i < arr.length; i++) s += Math.abs(arr[i] - arr[i - 1]);
  return s / (arr.length - 1);
};
const eased = jerk(perFrame);
// the un-eased version, for comparison — this is what it used to do
const raw = jerk(bursts.map((b, i) => bursts.slice(0, i + 1).reduce((a, c) => a + c, 0) > 0 ? b : 0));
assert.ok(eased < 1.0, `reveal is jerky: ${eased.toFixed(2)} chars/frame of change`);
assert.ok(eased < raw, 'easing made it no smoother than painting raw arrivals');

// ── 4. Both finalisers cancel the drain ──────────────────────────────────────
// The normal end of stream and the network/abort path. A frame left queued
// would repaint a stale slice over the finished reply. (A third
// `shownLen = fullReply.length` lives inside the loop as a clamp, which is why
// this counts the cancel and not the assignment.)
assert.equal((html.match(/cancelAnimationFrame\(drainRAF\)/g) || []).length, 2,
  'both the success path and the error path must cancel the drain');

// ── 5. The action buttons attach after the last paint, never before ──────────
// Every paint replaces the bubble's children, so appending them earlier means
// they vanish on the next frame — which is why a streamed reply never had them.
assert.ok(/msgEl\.appendChild\(makeMsgActions\(\)\)/.test(html),
  'streamed replies get no copy/share buttons');
const paintIdx = html.lastIndexOf('msgEl.innerHTML = renderMarkdown(fullReply)');
const actionIdx = html.indexOf('msgEl.appendChild(makeMsgActions())');
assert.ok(actionIdx > paintIdx, 'buttons are appended before the final paint and will be wiped');

console.log(`✓ stream reveal: converges at 7 sizes, 200-char burst in ${frames} frames `
          + `(~${(frames/60).toFixed(2)}s), jerk ${eased.toFixed(2)} vs ${raw.toFixed(2)} un-eased `
          + `(divisor ${divisor}, easing ${alpha})`);
