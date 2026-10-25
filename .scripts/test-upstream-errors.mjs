// Self-check: provider errors are not echoed to the browser (functions/chat.js).
// Run: node .scripts/test-upstream-errors.mjs
//
// WHY THIS EXISTS — audit SEC-14. When NVIDIA answered with an error, chat.js
// forwarded `errData.error.message` and NVIDIA's own status code to the client.
// That text names the provider, the model and the state of our key ("Authorization
// failed", "model not found: nvidia/…") — free reconnaissance for anyone probing
// the endpoint. The reader gains nothing from it either.
//
// Contract after the fix:
//   upstream 429  -> 429 with NO `code` (chat.html shows its neutral "provider is
//                    busy" text for an uncoded 429, which is the honest message)
//   anything else -> 502 'AI service error'
// and the upstream message string never appears in the response.
import assert from 'node:assert/strict';
import { makeFakeBackend, TEST_ENV, req, nvidiaStub } from './_fake-backend.mjs';

const { onRequest } = await import('../functions/chat.js');
const SECRET_TEXT = 'Authorization failed for key nvapi-abc on model nvidia/nemotron-3.5-lightning';

let ip = 0;
async function withUpstream(status) {
  const nv = nvidiaStub({ status, errorBody: { error: { message: SECRET_TEXT } } });
  globalThis.fetch = makeFakeBackend({ external: nv.handler, rpc: { match_documents: () => [] } }).fetch;
  const res = await onRequest({ env: TEST_ENV, request: req('/chat', {
    method: 'POST', body: { messages: [{ role: 'user', content: 'hi' }] }, ip: `192.0.2.${++ip}` }) });
  return { res, body: await res.text() };
}

for (const status of [400, 401, 403, 404, 500, 503]) {
  const { res, body } = await withUpstream(status);
  assert.equal(res.status, 502, `upstream ${status} should surface as 502, got ${res.status}`);
  assert.ok(!body.includes('Authorization failed') && !body.includes('nemotron'), `upstream ${status}: provider error text leaked: ${body}`);
}

{
  const { res, body } = await withUpstream(429);
  assert.equal(res.status, 429, 'upstream 429 must stay a 429 so the client shows "busy"');
  assert.equal(JSON.parse(body).code, undefined, 'a provider 429 must carry no code (coded 429s are OUR quotas)');
  assert.ok(!body.includes('Authorization failed'), 'provider error text leaked on 429');
}

console.log('upstream errors: OK');
