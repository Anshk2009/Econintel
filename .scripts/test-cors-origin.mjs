// Self-check: Access-Control-Allow-Origin is always ONE origin (all functions).
// Run: node .scripts/test-cors-origin.mjs
//
// WHY THIS EXISTS — audit SEC-18. ALLOWED_ORIGIN may list several origins,
// comma-separated, and every response copied that raw string into
// Access-Control-Allow-Origin. "https://a, https://b" is not a valid value — a
// browser treats it as a mismatch and blocks the response — so adding a second
// origin (a staging domain, a custom domain) would have silently broken every
// cross-origin call. The header now carries the first, canonical origin.
import assert from 'node:assert/strict';
import { makeFakeBackend, TEST_ENV, req, nvidiaStub } from './_fake-backend.mjs';

const env = { ...TEST_ENV, ALLOWED_ORIGIN: 'https://econintel.test, https://staging.econintel.test' };
const hibp = async (url) => (url.hostname === 'api.pwnedpasswords.com' ? new Response('') : null);
const nv = nvidiaStub();
globalThis.fetch = makeFakeBackend({
  external: async (u, i) => (await hibp(u)) || nv.handler(u, i),
  rpc: { match_documents: () => [] },
}).fetch;

const auth = (await import('../functions/auth.js')).onRequest;
const chat = (await import('../functions/chat.js')).onRequest;
const hist = (await import('../functions/chat-history.js')).onRequest;

const cases = {
  'auth preflight':      await auth({ env, request: req('/auth?action=login', { method: 'OPTIONS' }) }),
  'auth json 404':       await auth({ env, request: req('/auth?action=nope', { method: 'POST', body: {} }) }),
  'signup (manual hdrs)': await auth({ env, request: req('/auth?action=signup', { method: 'POST', body: { email: 'c@example.com', password: 'a long enough password', username: 'corsuser' } }) }),
  'chat SSE stream':     await chat({ env, request: req('/chat', { method: 'POST', body: { messages: [{ role: 'user', content: 'hi' }] } }) }),
  'history 401':         await hist({ env, request: req('/chat-history?action=get') }),
};
for (const [name, res] of Object.entries(cases)) {
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://econintel.test',
    `${name}: Access-Control-Allow-Origin was ${JSON.stringify(res.headers.get('Access-Control-Allow-Origin'))}`);
}
await cases['chat SSE stream'].text();

console.log('cors origin: OK');
