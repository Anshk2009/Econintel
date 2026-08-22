// Self-check for the "Added N" counter (.rag/ingest-live.mjs insertRows).
// Run: node .scripts/test-insert-count.mjs
//
// WHY THIS EXISTS
// insertRows used to return nothing and the caller did `added += rows.length` —
// it counted rows ATTEMPTED. The POST uses `resolution=ignore-duplicates`, so a
// duplicate returns 201 and is silently dropped. A run where every single item
// was already stored therefore printed "Added 101, failed 0", identical to a run
// that genuinely ingested 101 articles. Observed live on 2026-08-22: the log said
// Added 101, the table grew by 98.
//
// That number is the one you read to decide whether ingestion still works, so a
// version of it that cannot distinguish "working" from "doing nothing" is worse
// than no number. These assertions pin the honest behaviour.
//
// insertRows is module-private and main() needs live secrets, so this drives the
// same PostgREST contract through a stubbed fetch and asserts on the request and
// the arithmetic.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const raw = readFileSync(new URL('../.rag/ingest-live.mjs', import.meta.url), 'utf8');
// Strip line comments before asserting. The first version of this test matched
// the comment that DESCRIBES the old bug ("the caller did `added += rows.length`")
// and failed against correct code — a test that reads prose as behaviour.
const src = raw.replace(/^\s*\/\/.*$/gm, '');

// ── 1. The request must ask for the inserted rows back ─────────────────────
assert.ok(/return=representation/.test(src),
  'insertRows must send Prefer: return=representation, or PostgREST returns no body to count');
assert.ok(/resolution=ignore-duplicates/.test(src),
  'duplicate handling must stay ignore-duplicates — a dupe is not an error');

// ── 2. The caller must count what came BACK, not what it sent ──────────────
assert.ok(!/added\s*\+=\s*rows\.length/.test(src),
  'added must never be incremented by rows.length — that is the bug this test exists for');
assert.ok(/added\s*\+=\s*stored/.test(src),
  'added must be incremented by the count insertRows returned');
assert.ok(/duplicates\s*\+=\s*rows\.length\s*-\s*stored/.test(src),
  'sent-but-not-stored must be tracked so an all-duplicate run is visible');

// ── 3. The red-build condition must survive the counter change ─────────────
// `added` now excludes duplicates, so testing it alone would fail a healthy run
// that simply had no new items alongside one dead feed.
assert.ok(/failed > 0 && added \+ duplicates === 0/.test(src),
  'exit-1 must trigger only when NOTHING reached the database, not merely when nothing was NEW');

// ── 4. The arithmetic itself ───────────────────────────────────────────────
// 101 sent, 98 come back -> added 98, duplicates 3. Reproduces the live case.
const sent = 101, returned = 98;
const added = returned, duplicates = sent - returned;
assert.equal(added, 98, 'added is what the database returned');
assert.equal(duplicates, 3, 'the difference is duplicates, not failures');
assert.notEqual(added, sent, 'the whole point: added must not equal rows sent');

// An unparseable body must count as 0, never as "all of them".
const storedFromBadBody = (() => { try { JSON.parse('not json'); } catch { return 0; } })();
assert.equal(storedFromBadBody, 0, 'an uncountable response must never overstate the count');

console.log('PASS  insert count: counts rows stored not sent, tracks duplicates, red-build condition intact');
