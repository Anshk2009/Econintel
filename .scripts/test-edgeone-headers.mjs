// Self-check for edgeone.json — the security headers on every static page.
// Run: node .scripts/test-edgeone-headers.mjs
//
// WHY THIS EXISTS — audit SEC-06. HTML pages went out with no HSTS, no
// X-Frame-Options and no nosniff: a <meta> CSP cannot set those (they are
// header-only), and functions/_middleware.js never ran for static files. EdgeOne
// Pages reads edgeone.json from the repo root and applies its `headers` rules to
// static responses (https://pages.edgeone.ai/document/edgeone-json), so the fix
// lives in the repo. JSON cannot hold comments, so the reasoning lives here.
//
// Limits pinned from that page: at most 30 headers; key 1-100 chars of letters,
// digits and '-'; value 1-1000 chars; a source holds at most one '*'.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const cfg = JSON.parse(readFileSync(new URL('../edgeone.json', import.meta.url), 'utf8'));
const all = cfg.headers?.find(r => r.source === '/*');
assert.ok(all, 'edgeone.json needs a headers rule for "/*"');
const h = Object.fromEntries(all.headers.map(({ key, value }) => [key.toLowerCase(), value]));

// What smoke.mjs checks for on the live site, plus the two cheap extras.
assert.match(h['strict-transport-security'] || '', /^max-age=\d{7,}/, 'HSTS with a real max-age');
assert.equal(h['x-frame-options'], 'DENY', 'pages must not be framable (clickjacking)');
assert.equal(h['x-content-type-options'], 'nosniff');
assert.equal(h['referrer-policy'], 'strict-origin-when-cross-origin');
// frame-ancestors in a HEADER CSP: the modern clickjacking control, which a
// <meta> CSP is not allowed to carry. Only that directive, so it narrows nothing
// the per-page meta CSPs already decide.
assert.equal(h['content-security-policy'], "frame-ancestors 'none'");

// chat.html's voice input uses SpeechRecognition, which needs the microphone.
// Blocking it here would silently break the mic button.
const chat = readFileSync(new URL('../chat.html', import.meta.url), 'utf8');
if (/SpeechRecognition/.test(chat)) {
  assert.match(h['permissions-policy'] || '', /microphone=\(self\)/, 'voice input needs microphone=(self)');
}
assert.match(h['permissions-policy'] || '', /camera=\(\)/);

// EdgeOne's documented limits.
const count = cfg.headers.reduce((n, r) => n + r.headers.length, 0);
assert.ok(count <= 30, `${count} headers — EdgeOne allows at most 30`);
for (const r of cfg.headers) {
  assert.ok(r.source.startsWith('/') && (r.source.match(/\*/g) || []).length <= 1, `bad source ${r.source}`);
  for (const { key, value } of r.headers) {
    assert.match(key, /^[A-Za-z0-9-]{1,100}$/, `header key not allowed: ${key}`);
    assert.ok(typeof value === 'string' && value.length >= 1 && value.length <= 1000, `bad value for ${key}`);
  }
}

console.log('edgeone headers: OK');
