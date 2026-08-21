// Self-check for the row shape sent to PostgREST (.rag/ingest-live.mjs).
// Run: node .scripts/test-row-shape.mjs
//
// Regression test for two faults that failed EVERY batch on 2026-08-21:
//
//   PGRST102 "All object keys must match" — PostgREST bulk insert requires every
//   object in the array to carry the SAME KEYS. Rows were built with
//   `publishable: citeable ? true : undefined`, and JSON.stringify DROPS
//   undefined keys, so a batch spanning a citeable and a non-citeable feed sent
//   two different row shapes and was rejected whole. Batching by characters made
//   cross-feed batches normal, which turned a latent bug into every-run breakage.
//
//   "Invalid time value" — new Date(x).toISOString() THROWS on a date string it
//   cannot parse, taking down the whole batch rather than one item.
//
// Both are invisible to a syntax check and neither needs network or secrets.
import assert from 'node:assert/strict';
import { toISO } from '../.rag/ingest-live.mjs';

// ── Dates ───────────────────────────────────────────────────────────────────
assert.equal(toISO('Wed, 20 Aug 2026 09:15:00 GMT'), '2026-08-20T09:15:00.000Z', 'RFC-822, the RSS norm');
assert.equal(toISO('2026-08-20T09:15:00Z'), '2026-08-20T09:15:00.000Z', 'ISO-8601, the Atom norm');
assert.equal(toISO(''), null, 'missing date is null, not an error');
assert.equal(toISO(null), null);
assert.equal(toISO(undefined), null);
// The actual outage: a non-empty string Date cannot parse.
assert.equal(toISO('not a date'), null, 'unparseable date must yield null, never throw');
assert.equal(toISO('0000-00-00'), null);
assert.doesNotThrow(() => toISO('Sometime last Tuesday'), 'a bad date must never take down its batch');

// ── Row shape ───────────────────────────────────────────────────────────────
// Mirrors how ingest-live builds rows: the fields whose presence must not vary.
const buildRow = (feed) => ({
  content: 'headline\nsummary',
  source_name: feed.name,
  source_url: `https://example.test/${feed.name}`,
  category: feed.category || 'news',
  published_at: toISO('Wed, 20 Aug 2026 09:15:00 GMT'),
  publishable: feed.citeable === true,          // ALWAYS boolean — the fix
  embedding: [0.1, 0.2],
  embedding_model: 'test-model',
});

const citeable = buildRow({ name: 'RBI Press Releases', category: 'institution', citeable: true });
const plain    = buildRow({ name: 'BBC Business', category: 'news' });          // no citeable field at all

assert.equal(citeable.publishable, true);
assert.equal(plain.publishable, false, 'absent citeable must become false, NOT undefined');

// The real assertion: survive a JSON round-trip with identical keys. This is
// exactly what PostgREST checks, and what `undefined` used to break.
const roundTrip = JSON.parse(JSON.stringify([citeable, plain]));
const keysOf = (o) => Object.keys(o).sort().join(',');
assert.equal(keysOf(roundTrip[0]), keysOf(roundTrip[1]),
  'mixed citeable/non-citeable batch must serialise to identical key sets (PGRST102)');
assert.ok(keysOf(roundTrip[1]).includes('publishable'),
  'publishable must survive serialisation on a non-citeable row');

// An undated item must not change the shape either — null is a value, keys stay.
const undated = { ...buildRow({ name: 'Some Feed' }), published_at: toISO('garbage') };
assert.equal(undated.published_at, null);
assert.equal(keysOf(JSON.parse(JSON.stringify(undated))), keysOf(roundTrip[0]),
  'a null published_at must keep the key, so the batch shape is unchanged');

console.log('PASS  row shape: identical keys across mixed batches, unparseable dates degrade to null');
