// Self-check for SYSTEM_PROMPT (functions/chat.js).
// Run: node .scripts/test-prompt-invariants.mjs
//
// WHY THIS EXISTS
// The prompt was trimmed 1,362 -> 975 tokens because prefill is the largest
// share of time-to-first-token. Trimming a prompt is uniquely dangerous: nothing
// throws, no test goes red, and the only symptom of deleting a safety rule is
// that the model starts doing the thing the rule prevented — months later, in
// front of a reader, in a product whose entire claim is that it does not do that.
//
// These are the clauses that must survive ANY future edit for length. They are
// not stylistic. Each one is here because its absence produces a specific
// failure this product cannot afford:
//   - attribution: crediting source A with source B's figure
//   - current-data: inventing a number when retrieval returned nothing
//   - dating: presenting a stale reading as today's
//   - fabrication: making up sources, stats or events outright
// Style rules (tone, persona, bullet counts) are deliberately NOT asserted —
// those are meant to be editable.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../functions/chat.js', import.meta.url), 'utf8');
const i = src.indexOf('const SYSTEM_PROMPT');
const prompt = src.slice(i, src.indexOf('`;', i));
assert.ok(prompt.length > 500, 'SYSTEM_PROMPT not found or implausibly short');

const must = [
  // ATTRIBUTION — the one error that ends the product
  [/only the claim from THAT numbered entry/i,
   'attribution: a citation may carry only its own entry\'s claim'],
  [/never merge two entries into one sourced sentence/i,
   'attribution: entries must not be merged into one sourced sentence'],
  [/state it without a citation/i,
   'attribution: unattributable facts go uncited rather than mis-cited'],
  // CURRENT DATA — the anti-hallucination escape hatch, exact wording matters
  [/I don't have current data on this — will get it updated\./,
   'current-data: the exact refusal string must be preserved verbatim'],
  [/[Nn]ever fill the gap with invented figures/i,
   'current-data: must forbid filling gaps with invented figures'],
  // DATING — stale readings presented as current
  [/only true AS OF that date/i, 'dating: retrieved items are true only as of their date'],
  [/never write a dated reading in the present tense/i,
   'dating: must forbid present-tensing a dated figure'],
  // SOURCES mechanics
  [/MUST end with one line: "Sources:/,
   'sources: the citation line is mandatory when a block is present'],
  [/say nothing about sources at all/i,
   'sources: silence when no block — never announce an absence'],
  [/Cite only entries listed in the block, exactly as given/i,
   'sources: no citing anything outside the block'],
  // FABRICATION
  [/Never invent a source, URL, publisher, date, statistic or historical event/i,
   'fabrication: blanket prohibition must survive'],
  [/Never fabricate a number, statistic or precedent/i,
   'uncertainty: no fabricated numbers when uncertain'],
];

const missing = must.filter(([re]) => !re.test(prompt)).map(([, why]) => why);
assert.equal(missing.length, 0,
  `SYSTEM_PROMPT lost ${missing.length} load-bearing rule(s):\n  - ${missing.join('\n  - ')}`);

// Budget guard: prefill is the point of the trim. If the prompt creeps back past
// where it started, the latency work was undone without anyone noticing.
const approxTokens = Math.round(prompt.length / 4);
assert.ok(approxTokens < 1200,
  `SYSTEM_PROMPT is ~${approxTokens} tokens; it was trimmed to ~975 to cut prefill. ` +
  `Growing it back past 1200 undoes that — trim elsewhere or raise this bound deliberately.`);

console.log(`PASS  prompt invariants: all ${must.length} safety rules intact, ~${approxTokens} tokens`);
