// Self-check for chat.html's renderMarkdown — the function that writes model
// output into innerHTML.
// Run: node .scripts/test-render-markdown.mjs
//
// The functions are lifted out of chat.html and evaluated, so this tests the
// shipped code, not a copy of it.
//
// CITATION ALLOWLIST (audit SEC-03 / RAG-06). chat.js sends the URLs it
// retrieved as the first stream event. renderMarkdown(raw, allowedUrls) must
// link ONLY those; any other link the model wrote renders as its plain text.
// With no allowlist (null — an old server, or a reopened thread whose saved text
// the server already cleaned) the previous behaviour stands: https links render.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../chat.html', import.meta.url), 'utf8');
const grab = (name) => {
  const m = html.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
  assert.ok(m, `could not find function ${name} in chat.html`);
  return m[0];
};
const renderMarkdown = new Function(`${grab('escapeHTML')}\n${grab('renderMarkdown')}\nreturn renderMarkdown;`)();

const REAL = 'https://www.rbi.org.in/press/123';
const text = `Held at 5.5%.\n\nSources: [RBI](${REAL}), [calculator](https://phish.example/rbi)`;

// ── allowlist ───────────────────────────────────────────────────────────────
{
  const out = renderMarkdown(text, new Set([REAL]));
  assert.ok(out.includes(`<a href="${REAL}"`), 'a retrieved URL must render as a link');
  assert.ok(!out.includes('href="https://phish.example'), 'an unlisted URL rendered as a link');
  assert.ok(out.includes('calculator'), 'the unlisted link\'s TEXT should still show');
}
{
  const out = renderMarkdown(text, new Set());
  assert.ok(!out.includes('<a '), 'with an empty allowlist nothing may be a link');
}
{
  const out = renderMarkdown(text);   // no allowlist at all
  assert.ok(out.includes(`<a href="${REAL}"`) && out.includes('href="https://phish.example/rbi"'),
    'without an allowlist the old behaviour (https links render) must stand');
}

// ── XSS corpus (audit QA-01) ────────────────────────────────────────────────
// Model output reaches innerHTML through this function, and the model can be
// steered by a poisoned feed item — so these are the payloads a feed author
// would try. None may produce a live tag, attribute handler, or script URL.
// (Characterisation tests: the escaping already works; these make sure it keeps
// working. Each was mutation-checked by removing the Step 1b escape.)
const payloads = [
  '<img src=x onerror=alert(1)>',
  '<script>alert(1)</script>',
  '<svg/onload=alert(1)>',
  '[click](javascript:alert(1))',
  '[click](JaVaScRiPt:alert(1))',
  '[click](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
  '[x](https://ok.test/" onmouseover="alert(1))',
  "[x](https://ok.test/' onmouseover='alert(1))",
  '**<b onclick=alert(1)>bold</b>**',
  '`<img src=x onerror=alert(1)>`',
  '```\n<script>alert(1)</script>\n```',
  '# <iframe src=//evil.test>',
  '- <a href="javascript:alert(1)">item</a>',
  '[<img src=x onerror=alert(1)>](https://ok.test/)',
];
for (const p of payloads) {
  for (const allow of [null, new Set(['https://ok.test/'])]) {
    const out = renderMarkdown(p, allow);
    assert.ok(!/<(img|script|svg|iframe|b)\b/i.test(out), `live tag from: ${p}\n  -> ${out}`);
    // An event handler only exists if it is a real ATTRIBUTE: look inside each
    // tag with its quoted values removed. (An escaped &quot; keeps "onmouseover"
    // inside the href value, where it is inert — that is the escaping working.)
    const handler = (out.match(/<[a-z][^>]*>/gi) || []).some(tag => /\son\w+\s*=/i.test(tag.replace(/"[^"]*"/g, '""')));
    assert.ok(!handler, `event handler attribute from: ${p}\n  -> ${out}`);
    assert.ok(!/href="\s*(javascript|data|vbscript):/i.test(out), `script URL in href from: ${p}\n  -> ${out}`);
  }
}

console.log('render markdown: OK');
