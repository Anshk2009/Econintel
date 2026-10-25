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

console.log('render markdown: OK');
