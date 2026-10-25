// Self-check: the edge functions use the secret key or refuse to start.
// Run: node .scripts/test-supabase-key.mjs
//
// WHY THIS EXISTS — audit QA-03. resolveSupabaseKey() tried SUPABASE_SECRET_KEY,
// then a hand-base64'd legacy service_role JWT, then the ANON key. RLS has been
// on for every table since 2026-08-22 with no policies, so the anon key can do
// nothing: falling back to it turned "the secret is missing" into a stream of
// confusing denials and silently empty reads — the fail-open shape that cost a
// month once already. Now: the secret key, or a named startup error.
import assert from 'node:assert/strict';
import { resolveSupabaseKey } from '../functions/middleware.js';
import { makeFakeBackend, TEST_ENV, req } from './_fake-backend.mjs';

assert.equal(resolveSupabaseKey({ SUPABASE_SECRET_KEY: ' sb_secret_abc \n' }), 'sb_secret_abc', 'the secret key, trimmed');
assert.equal(resolveSupabaseKey({ SUPABASE_ANON_KEY: 'anon' }), undefined, 'must not fall back to the anon key');
assert.equal(resolveSupabaseKey({ SUPABASE_SERVICE_KEY_B64: Buffer.from('eyJ.legacy').toString('base64') }), undefined,
  'must not fall back to the legacy base64-wrapped key');

// With only the anon key configured, every function refuses loudly.
globalThis.fetch = makeFakeBackend().fetch;
const env = { ...TEST_ENV, SUPABASE_SECRET_KEY: undefined, SUPABASE_ANON_KEY: 'anon' };
for (const f of ['auth', 'chat', 'chat-history']) {
  const { onRequest } = await import(`../functions/${f}.js`);
  await assert.rejects(() => onRequest({ env, request: req(`/${f}`, { method: 'POST', body: {} }) }), /SUPABASE_SECRET_KEY/,
    `${f}.js started without the secret key`);
}

console.log('supabase key: OK');
