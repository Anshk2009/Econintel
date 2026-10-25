// Self-check: the ingesters write with the service-role key, never the anon key.
// Run: node .scripts/test-ingest-key.mjs
//
// WHY THIS EXISTS — audit QA-03. sources/_lib.mjs used
// SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY. RLS is on for `documents`
// with no policies, so a write as anon can only fail — with 42501 on every
// batch, which is exactly how ingestion broke on 2026-08-21 and read as
// "something is wrong with the data" rather than "a secret is missing".
// Now the key is the service-role key or nothing, and every script that writes
// names SUPABASE_SERVICE_ROLE_KEY when it is absent.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Load _lib.mjs in a child with ONLY the anon key set (no network is touched).
const lib = new URL('../.rag/sources/_lib.mjs', import.meta.url).href;
const probe = (env) => execFileSync(process.execPath, ['--input-type=module', '-e',
  `const l = await import(${JSON.stringify(lib)}); console.log(JSON.stringify({ key: l.SUPABASE_KEY ?? null }));`],
  { env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env }, encoding: 'utf8' });

assert.equal(JSON.parse(probe({ SUPABASE_ANON_KEY: 'anon-only' })).key, null, 'the ingesters fell back to the anon key');
assert.equal(JSON.parse(probe({ SUPABASE_SERVICE_ROLE_KEY: 'svc' })).key, 'svc');

// Each writer's preflight must name the key it actually needs.
for (const f of ['ingest-live.mjs', 'ingest-data.mjs', 'reembed.mjs']) {
  const src = readFileSync(new URL(`../.rag/${f}`, import.meta.url), 'utf8');
  assert.ok(!/SUPABASE_ANON_KEY or SUPABASE_SERVICE_ROLE_KEY|requireEnv\(\[[^\]]*'SUPABASE_ANON_KEY'/.test(src),
    `${f} still accepts the anon key in its preflight`);
  assert.match(src, /SUPABASE_SERVICE_ROLE_KEY/, `${f} must name SUPABASE_SERVICE_ROLE_KEY when it is missing`);
}

console.log('ingest key: OK');
