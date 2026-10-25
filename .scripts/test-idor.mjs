// Self-check: one user can never reach another user's chats (chat-history.js).
// Run: node .scripts/test-idor.mjs
//
// Every chat_history query is scoped by the userId from the verified JWT, never
// by anything the client sends. This pins that for each action, including the
// one input that IS client-chosen: conversation_id. Bob knowing (or guessing)
// Alice's thread id must get him nothing.
// Characterisation tests: this already holds. Mutation-checked by dropping the
// user_id filter from handleGetHistory (the thread case then fails).
import assert from 'node:assert/strict';
import { makeFakeBackend, TEST_ENV, req, signIn } from './_fake-backend.mjs';

const hist = (await import('../functions/chat-history.js')).onRequest;
const fb = makeFakeBackend();
globalThis.fetch = fb.fetch;
const alice = await signIn(fb, { id: 'alice-id' });
const bob = await signIn(fb, { id: 'bob-id' });
const now = new Date().toISOString();
fb.tables.chat_history.push(
  { id: 'm1', user_id: 'alice-id', role: 'user', content: "Alice's private question", conversation_id: 'alice-thread', created_at: now, deleted_at: null },
  { id: 'm2', user_id: 'alice-id', role: 'assistant', content: "Alice's private answer", conversation_id: 'alice-thread', created_at: now, deleted_at: null },
);
fb.tables.kv_store.push({ key: 'csrf:bobtok', value: JSON.stringify({ userId: 'bob-id' }), expires_at: new Date(Date.now() + 3600e3).toISOString() });

const asBob = (path, opts = {}) => hist({ env: TEST_ENV, request: req(path, { ...opts, cookies: { ...bob, csrf_token: 'bobtok', ...(opts.cookies || {}) } }) });
const leaked = (text) => text.includes('Alice');

for (const path of ['/chat-history?action=get', '/chat-history?action=get&conversation_id=alice-thread',
                    '/chat-history?action=conversations', '/chat-history?action=export']) {
  const r = await asBob(path);
  assert.equal(r.status, 200, `${path}: ${r.status}`);
  assert.ok(!leaked(await r.text()), `${path}: Bob received Alice's messages`);
}

// Bob's delete only touches Bob's rows.
const del = await asBob('/chat-history?action=delete', { method: 'DELETE', headers: { 'X-CSRF-Token': 'bobtok' } });
assert.equal(del.status, 200);
assert.equal(fb.tables.chat_history.filter(r => r.user_id === 'alice-id').length, 2, "Bob's delete removed Alice's messages");

// Control: Alice sees her own thread.
const mine = await hist({ env: TEST_ENV, request: req('/chat-history?action=get&conversation_id=alice-thread', { cookies: alice }) });
assert.ok(leaked(await mine.text()), "Alice cannot read her own thread — the test is not exercising reads");

console.log('idor: OK');
