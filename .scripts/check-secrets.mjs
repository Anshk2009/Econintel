// Fail CI if a credential is committed anywhere in the repo.
// Run: node .scripts/check-secrets.mjs        (scans every git-tracked file)
//
// Replaces three grep lines in ci.yml (audit SEC-16) that only knew an
// OpenRouter key, an HS256 JWT header and `JWT_SECRET = "…"` — none of the keys
// this project actually holds today. Each pattern below is the real shape of a
// credential EconIntel uses or has used, sized so documentation placeholders
// ("nvapi-your-key", "sb_secret_…") do not match.
// ponytail: regexes over tracked files, not a full scanner. Swap in gitleaks if
// a pattern this list does not know about ever matters.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const PATTERNS = [
  ['NVIDIA API key',        /nvapi-[A-Za-z0-9_-]{30,}/],
  ['Supabase secret key',   /sb_secret_[A-Za-z0-9_-]{20,}/],
  ['Supabase / JWT token',  /eyJhbGciOi[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/],
  ['Google OAuth secret',   /GOCSPX-[A-Za-z0-9_-]{20,}/],
  ['Resend API key',        /\bre_[A-Za-z0-9]{24,}\b/],
  ['GitHub token',          /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['OpenRouter key',        /sk-or-v1-[0-9a-f]{32,}/],
  ['AWS access key',        /\bAKIA[0-9A-Z]{16}\b/],
  ['private key',           /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/],
];

// Every match in a piece of text, as [patternName, matchedText].
export function findSecrets(text) {
  const hits = [];
  for (const [name, re] of PATTERNS) {
    const m = text.match(re);
    if (m) hits.push([name, m[0]]);
  }
  return hits;
}

// CLI: scan tracked files, skipping binaries and the vendored WASM bundle
// (base64 blobs match nothing here, but there is no reason to read 100 KB of it).
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean)
    .filter(f => !/\.(png|jpg|jpeg|gif|ico|webp|woff2?)$/i.test(f) && f !== 'functions/argon2.js');
  let found = 0;
  for (const f of files) {
    let text;
    try { text = readFileSync(f, 'utf8'); } catch { continue; }
    for (const [name, match] of findSecrets(text)) {
      found++;
      console.log(`  ❌ ${f}: possible ${name} (${match.slice(0, 12)}…)`);
    }
  }
  if (found) { console.log(`${found} possible secret(s) committed — rotate them, then remove.`); process.exit(1); }
  console.log(`  ✅ No secrets in ${files.length} tracked files`);
}
