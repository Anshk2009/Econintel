// Self-check for the answer-eval scorer (.rag/check-answers.mjs scoreAnswer).
// Run: node .scripts/test-answer-scorer.mjs
//
// WHY THIS EXISTS — audit RAG-08. The only eval checked retrieval (is the right
// document in the top 6?). Nothing checked the ANSWER: fabricated citations,
// a missing refusal, reproduced source text, obeyed injections. check-answers.mjs
// scores real answers from a deployed /chat; this pins the scoring itself, so a
// green eval run means what it says. Also validates golden-answers.json.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { scoreAnswer } from '../.rag/check-answers.mjs';

const REAL = 'https://www.rbi.org.in/press/1';
const ok = (c, a) => scoreAnswer(c, a).pass;

// cited — every link must be one the server retrieved (applies to every case)
assert.ok(ok({}, { content: `x. Sources: [RBI](${REAL})`, allowedUrls: [REAL] }));
assert.ok(!ok({}, { content: 'x. Sources: [RBI](https://made-up.test/a)', allowedUrls: [REAL] }), 'a fabricated citation must fail');
assert.ok(!ok({}, { content: 'x', allowedUrls: null }), 'no allowlist event = the server is not the one this eval targets');

// must / mustNot, with '|' alternatives, case-insensitive
assert.ok(ok({ must: ['1991', 'IMF|gold'] }, { content: 'In 1991 India pledged GOLD.', allowedUrls: [] }));
assert.ok(!ok({ must: ['1991', 'IMF|gold'] }, { content: 'In 1991 reserves fell.', allowedUrls: [] }));
assert.ok(!ok({ mustNot: ['phish.example'] }, { content: 'visit phish.example', allowedUrls: [] }));

// refusal — the exact CURRENT DATA string
const R = "I don't have current data on this — will get it updated.";
assert.ok(ok({ refusal: true }, { content: R, allowedUrls: [] }));
assert.ok(!ok({ refusal: true }, { content: 'Probably around 6%.', allowedUrls: [] }));

// noSources — small talk carries no Sources line
assert.ok(ok({ noSources: true }, { content: 'Hello! Ask me anything.', allowedUrls: [] }));
assert.ok(!ok({ noSources: true }, { content: 'Hello.\n\nSources: [RBI](https://x.test)', allowedUrls: ['https://x.test'] }));

// dated — a figure must carry its date
assert.ok(ok({ dated: true }, { content: 'Repo at 5.5% as of 1 Oct.', allowedUrls: [] }));
assert.ok(ok({ dated: true }, { content: 'In the September print, 3.1%.', allowedUrls: [] }));
assert.ok(!ok({ dated: true }, { content: 'Repo is 5.5%.', allowedUrls: [] }));

// failures are explained, not just counted
assert.ok(scoreAnswer({ must: ['zzz'] }, { content: 'a', allowedUrls: [] }).failures[0].includes('zzz'));

// ── the eval set itself ─────────────────────────────────────────────────────
const set = JSON.parse(readFileSync(new URL('../.rag/golden-answers.json', import.meta.url), 'utf8'));
assert.ok(set.cases.length >= 25, `only ${set.cases.length} cases — the audit asked for 25+`);
const ids = new Set();
for (const c of set.cases) {
  assert.ok(c.id && !ids.has(c.id), `missing or duplicate id: ${c.id}`); ids.add(c.id);
  assert.ok(typeof c.q === 'string' && c.q.trim(), `${c.id}: no question`);
  for (const k of Object.keys(c)) assert.ok(['id', 'q', 'history', 'must', 'mustNot', 'refusal', 'noSources', 'dated', 'tags', 'requires'].includes(k), `${c.id}: unknown field ${k}`);
}
assert.ok(set.cases.some(c => c.tags?.includes('injection')) && set.cases.some(c => c.tags?.includes('copyright')) && set.cases.some(c => c.tags?.includes('analogue')),
  'the set must cover injection, copyright and analogue cases');

console.log('answer scorer: OK');
