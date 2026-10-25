// Self-check: every feed in .rag/feeds.json is fetched over HTTPS.
// Run: node .scripts/test-feeds-https.mjs
//
// WHY THIS EXISTS — audit SEC-03. Feed text lands in the model's context. A
// feed fetched over plain http:// can be rewritten by anyone on the network
// path between the GitHub runner and the publisher, which turns "a publisher
// we chose" into "whoever is in the middle" — a prompt-injection channel that
// needs no account anywhere. arXiv (open submissions, already the riskiest
// feed) was the one still on http://.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { feeds } = JSON.parse(readFileSync(new URL('../.rag/feeds.json', import.meta.url), 'utf8'));
const plain = feeds.filter(f => !/^https:\/\//.test(f.url)).map(f => `${f.name}: ${f.url}`);
assert.equal(plain.length, 0, `feeds not on https:\n  ${plain.join('\n  ')}`);
console.log(`feeds https: all ${feeds.length} OK`);
