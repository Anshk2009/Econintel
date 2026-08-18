// Self-check for the retrieval-failure notice (functions/chat.js).
// Run: node .scripts/test-prepend-notice.mjs
//
// Worth a test because it is the one piece of this change that is stream
// plumbing rather than plain data shuffling: get the SSE framing wrong and the
// client silently drops the notice, which is precisely the invisible-failure
// mode the notice exists to end. Asserts the notice arrives FIRST, parses as a
// real delta, and that the upstream bytes then pass through untouched.
import assert from 'node:assert/strict';
import { prependNotice } from '../functions/chat.js';

const enc = new TextEncoder(), dec = new TextDecoder();

function upstreamOf(...chunks) {
  let i = 0;
  return new ReadableStream({
    pull(c) { i < chunks.length ? c.enqueue(enc.encode(chunks[i++])) : c.close(); },
  });
}
async function drain(stream) {
  let out = '';
  for (const r = stream.getReader(); ;) {
    const { done, value } = await r.read();
    if (done) return out;
    out += dec.decode(value, { stream: true });
  }
}

// The two real upstream chunks, as OpenRouter/NVIDIA send them.
const a = `data: ${JSON.stringify({ choices: [{ delta: { content: 'Rupee ' } }] })}\n\n`;
const b = `data: ${JSON.stringify({ choices: [{ delta: { content: 'weakened.' } }] })}\n\ndata: [DONE]\n\n`;

const NOTICE = 'Heads up: unreachable.\n\n';
const got = await drain(prependNotice(upstreamOf(a, b), NOTICE));

// 1. Upstream is preserved byte-for-byte, in order, at the end.
assert.ok(got.endsWith(a + b), 'upstream chunks must pass through unchanged');

// 2. The notice is FIRST — after it, the user still sees the whole reply.
const events = got.split('\n\n').filter(Boolean);
assert.equal(events.length, 4, `expected notice + 2 deltas + [DONE], got ${events.length}`);

// 3. It parses with the exact shape chat.html and the history accumulator read.
const first = JSON.parse(events[0].slice('data: '.length));
assert.equal(first.choices[0].delta.content, NOTICE, 'notice must be a delta.content');

// 4. Concatenating deltas the way both consumers do yields notice + full answer.
const text = events
  .filter(e => !e.includes('[DONE]'))
  .map(e => JSON.parse(e.slice('data: '.length)).choices[0].delta.content)
  .join('');
assert.equal(text, NOTICE + 'Rupee weakened.');

// 5. No notice requested -> stream is untouched (the common path).
assert.equal(await drain(upstreamOf(a, b)), a + b);

console.log('PASS  prependNotice: notice first, valid SSE delta, upstream intact');
