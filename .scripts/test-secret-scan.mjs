// Self-check for the CI secret scanner (.scripts/check-secrets.mjs).
// Run: node .scripts/test-secret-scan.mjs
//
// WHY THIS EXISTS — audit SEC-16. The old CI step grepped for three shapes: an
// OpenRouter key (a provider this project no longer uses), an HS256 JWT header,
// and `JWT_SECRET = "…"`. It could not see a single key this project actually
// holds: NVIDIA (nvapi-…), Supabase's new secret key (sb_secret_…), the Google
// OAuth secret (GOCSPX-…), the Resend key (re_…), GitHub tokens.
//
// The fixtures are ASSEMBLED at runtime ('nv' + 'api-' + …) so this file never
// contains a string the scanner would flag in itself.
import assert from 'node:assert/strict';
import { findSecrets } from './check-secrets.mjs';

const r = (n) => 'A1b2C3d4E5'.repeat(Math.ceil(n / 10)).slice(0, n);
const mustCatch = {
  'NVIDIA key':           'nv' + 'api-' + r(40),
  'Supabase secret key':  'sb_' + 'secret_' + r(30),
  'Supabase JWT':         'ey' + 'JhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' + 'ey' + 'J' + r(40) + '.' + r(43),
  'Google OAuth secret':  'GOC' + 'SPX-' + r(28),
  'Resend key':           're' + '_' + r(32),
  'GitHub token':         'gh' + 'p_' + r(36),
  'OpenRouter key':       'sk-' + 'or-v1-' + 'ab12'.repeat(16),
  'private key':          '-----BEGIN ' + 'PRIVATE KEY-----',
};
for (const [name, secret] of Object.entries(mustCatch)) {
  const hits = findSecrets(`const k = "${secret}";`);
  assert.ok(hits.length > 0, `scanner missed: ${name}`);
}

// Placeholders and ordinary prose must NOT trip it (.env.example is full of them).
for (const ok of ['NVIDIA_API_KEY=nvapi-your-key', 'SUPABASE_SECRET_KEY=', 're_used the value', 'sb_secret_… (see README)']) {
  assert.deepEqual(findSecrets(ok), [], `false positive on: ${ok}`);
}

console.log('secret scan: OK');
