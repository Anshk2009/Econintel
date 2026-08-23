// Self-check for trimHistory() (chat.html).
// Run: node .scripts/test-history-trim.mjs
//
// WHY THIS EXISTS
// The client used to send the entire conversation on every message and never
// trim it, while functions/chat.js rejects any request carrying more than 30.
// So a thread DIED at the 15th exchange — a raw 400 mid-conversation, on the
// longest and most invested chats. Nothing detected it: the request is
// well-formed, the server is behaving correctly, and it only fails for readers
// who stayed.
//
// The invariant that actually matters is the RELATIONSHIP between two numbers
// living in two different files. Raise the client cap, or lower the server's,
// and the bug comes back silently. That pairing is asserted first, below.
//
// The logic is read out of chat.html rather than restated here: a test carrying
// its own copy of the function proves only that the copy is self-consistent.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../chat.html', import.meta.url), 'utf8');
const chatJs = readFileSync(new URL('../functions/chat.js', import.meta.url), 'utf8');

// ── 1. The cross-file invariant ──────────────────────────────────────────────
const serverCap = Number((chatJs.match(/body\.messages\.length\s*>\s*(\d+)/) || [])[1]);
const clientCap = Number((html.match(/const MAX_SENT_MESSAGES\s*=\s*(\d+)/) || [])[1]);
assert.ok(serverCap, 'could not find the server message cap in functions/chat.js');
assert.ok(clientCap, 'could not find MAX_SENT_MESSAGES in chat.html');
assert.ok(
  clientCap < serverCap,
  `client cap (${clientCap}) must stay BELOW the server cap (${serverCap}); `
  + 'sitting on the limit turns any future off-by-one back into a 400 mid-chat',
);

// ── Lift the real implementation out of the page ─────────────────────────────
function slice(startMarker, endMarker) {
  const i = html.indexOf(startMarker);
  assert.ok(i > -1, `not found in chat.html: ${startMarker}`);
  const j = html.indexOf(endMarker, i);
  assert.ok(j > -1, `end marker not found after: ${startMarker}`);
  return html.slice(i, j + endMarker.length);
}

const source = [
  slice('const MAX_SENT_MESSAGES', ';'),
  slice('const isArticleContext', "'[ARTICLE CONTEXT');"),
  slice('function trimHistory()', '\n}'),
].join('\n');

// `history` is a closure variable in the page; passing it in as a parameter
// gives the extracted function the same thing to mutate.
const buildTrim = new Function('history', `${source}\nreturn trimHistory;`);

const CTX = { role: 'user', content: '[ARTICLE CONTEXT — the reader just finished this piece]' };
const turns = (n, offset = 0) =>
  Array.from({ length: n }, (_, i) => ({
    role: (i + offset) % 2 === 0 ? 'user' : 'assistant',
    content: `m${i}`,
  }));

function trimmed(initial) {
  const history = initial.slice();
  buildTrim(history)();
  return history;
}

// ── 2. Under the cap: untouched ──────────────────────────────────────────────
const short = turns(6);
assert.deepEqual(trimmed(short), short, 'a short thread must not be modified at all');

const exact = turns(clientCap);
assert.deepEqual(trimmed(exact), exact, 'a thread exactly at the cap must not be modified');

// ── 3. Over the cap: bounded, and the newest turn survives ───────────────────
const long = trimmed(turns(40));
assert.ok(long.length <= clientCap, `trimmed to ${long.length}, expected <= ${clientCap}`);
assert.ok(long.length < serverCap, 'trimmed payload must clear the server cap');
assert.equal(long.at(-1).content, 'm39', 'the message just sent must never be trimmed away');
assert.equal(long[0].role, 'user', 'a trimmed thread must not open on an assistant turn');

// ── 4. The shift branch: a slice landing mid-exchange ────────────────────────
// 41 turns puts an assistant message at the head of the slice, which must be
// dropped — otherwise the model sees a reply to a question that is gone.
const odd = trimmed(turns(41));
assert.equal(odd[0].role, 'user', 'leading assistant turn must be dropped');
assert.equal(odd.at(-1).content, 'm40', 'newest turn still preserved on the shift path');

// ── 5. Article context survives, and stays at the front ──────────────────────
// The chip on screen says "Reading context: <title>". If trimming drops the
// message while the chip stays up, the UI claims the terminal is holding an
// article it has stopped sending.
const withCtx = trimmed([CTX, ...turns(40, 1)]);
assert.ok(withCtx.includes(CTX), 'article context must survive a trim');
assert.equal(withCtx[0], CTX, 'article context must stay at the head of the payload');
assert.ok(withCtx.length <= clientCap, 're-seating the context must still respect the cap');
assert.equal(withCtx.at(-1).content, 'm39', 'newest turn preserved alongside the context');

// ── 6. Repeated trims are stable ─────────────────────────────────────────────
// Every send calls this, so it runs against its own output for the rest of the
// conversation. It must be idempotent or the thread erodes a turn at a time.
const once = trimmed(turns(40));
assert.deepEqual(trimmed(once), once, 'trimming an already-trimmed thread must be a no-op');

console.log(`✓ history trim: client cap ${clientCap} < server cap ${serverCap}, `
          + '6 cases (under, exact, over, mid-exchange, article context, idempotent)');
