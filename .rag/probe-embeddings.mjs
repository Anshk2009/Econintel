// probe-embeddings.mjs — PRE-FLIGHT GATE for the NVIDIA embedding switch.
// Run: node .rag/probe-embeddings.mjs
//
// Needs: NVIDIA_API_KEY, SUPABASE_URL, and SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY.
//
// WHY THIS EXISTS
// The provider switch asserts three things, and NOT ONE of them can be proved by
// reading code or by the self-checks in .scripts/ — those stub fetch, so they all
// pass whether or not NVIDIA agrees. Each needs one real call:
//
//   1. Is the key VALID and ENTITLED? 403 "Authorization failed" comes back both
//      for a dead key AND for a live key whose account may not use this NIM.
//      Identical status, identical body. Only a working call tells them apart.
//   2. Does the model return 2048 dims? documents.embedding is vector(2048). A
//      different number means REBUILDING the column, not re-embedding it — and
//      you want that known before touching 15,000 rows, not after.
//   3. DID THE COORDINATE SPACE ACTUALLY MOVE? This is the expensive one.
//      OpenRouter is a ROUTER, not a host: `nvidia/nemotron-3-embed-1b:free` was
//      very likely served by NVIDIA's own inference all along — same weights,
//      same space — in which case re-embedding the corpus is days of quota spent
//      to change a STRING. What genuinely might have moved it is that the old
//      call sent no input_type and the new one sends 'passage'. Section 3
//      settles it by MEASUREMENT: take a row already stored, re-embed its exact
//      content through the NEW path, cosine it against the vector in the DB.
//
// Costs 3 embedding requests. Writes nothing.
import process from 'node:process';
import { EMBED_MODEL, SUPABASE_URL, SUPABASE_KEY } from './sources/_lib.mjs';

const NV_KEY = (process.env.NVIDIA_API_KEY || '').trim();
const NV = 'https://integrate.api.nvidia.com/v1';
const TIMEOUT_MS = 20000;

async function post(url, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${NV_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: ctrl.signal,
    });
    return { status: r.status, text: await r.text() };
  } catch (e) {
    return { status: 0, text: e.name === 'AbortError' ? 'timed out' : e.message };
  } finally { clearTimeout(timer); }
}

const embed = (input, input_type) =>
  post(`${NV}/embeddings`, { model: EMBED_MODEL, input, input_type,
                             encoding_format: 'float', truncate: 'END' });

// Pull the vectors out, or print the exact upstream body. The body is the whole
// point — a guess about why it failed is worth nothing next to what it said.
function vectorsOf({ status, text }) {
  try {
    const j = JSON.parse(text);
    if (Array.isArray(j.data) && j.data[0]?.embedding)
      return j.data.sort((a, b) => a.index - b.index).map(d => d.embedding);
  } catch { /* not JSON — fall through to the raw body */ }
  console.log(`  FAILS   HTTP ${status}: ${text.replace(/\s+/g, ' ').slice(0, 220)}`);
  return null;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

if (!NV_KEY) {
  console.log('NVIDIA_API_KEY not set in this shell. Copy it out of EdgeOne and retry.');
  process.exit(1);
}
console.log(`key:   ${NV_KEY.slice(0, 8)}... (${NV_KEY.length} chars)`);
console.log(`model: ${EMBED_MODEL}\n`);

// ─── 1. IS THE KEY ACCEPTED AT ALL? ─────────────────────────────────────────
console.log('=== 1. Key valid and entitled? ===');
const chat = await post(`${NV}/chat/completions`, {
  model: 'nvidia/nemotron-3.5-lightning-30b-a3b',
  messages: [{ role: 'user', content: 'hi' }], max_tokens: 4,
  chat_template_kwargs: { enable_thinking: false },
});
if (chat.status === 200) {
  console.log('  OK      chat generation authorized (this also proves the free-tier model id is live)');
} else if (chat.status === 403) {
  console.log('  DEAD    403 — key rejected, or the account is not entitled to this model.');
  console.log('          Regenerate at build.nvidia.com. Body:');
  console.log(`          ${chat.text.replace(/\s+/g, ' ').slice(0, 180)}`);
} else {
  console.log(`  HTTP ${chat.status}: ${chat.text.replace(/\s+/g, ' ').slice(0, 200)}`);
}

// ─── 2. EMBEDDING MODEL + DIMENSIONS ────────────────────────────────────────
console.log('\n=== 2. Embedding model answers, at what size? ===');
const probe = vectorsOf(await embed(['India current account deficit widened.',
                                     'The central bank held the policy rate at 6.5 percent.'], 'passage'));
if (probe) {
  const dims = probe[0].length;
  console.log(`  OK      ${probe.length} vectors, ${dims} dimensions` +
    (dims === 2048 ? '  <-- matches the vector(2048) column'
                   : '  <-- STOP. COLUMN REBUILD NEEDED (currently 2048)'));
}

// ─── 3. DID THE SPACE MOVE? ─────────────────────────────────────────────────
console.log('\n=== 3. Are the stored vectors still valid? ===');
if (!probe) {
  console.log('  SKIP    section 2 failed; nothing to compare against.');
} else if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.log('  SKIP    SUPABASE_URL / SUPABASE_*_KEY not set in this shell.');
} else {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/documents?select=id,content,embedding,embedding_model` +
                        `&content=not.is.null&embedding=not.is.null&order=id.desc&limit=1`,
                        { headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'apikey': SUPABASE_KEY } });
  const rows = r.ok ? await r.json() : [];
  if (!rows.length) {
    console.log(`  SKIP    could not read a stored row (HTTP ${r.status}).`);
  } else {
    const row = rows[0];
    // pgvector comes back over PostgREST as a JSON-ish string, not an array.
    const stored = typeof row.embedding === 'string' ? JSON.parse(row.embedding) : row.embedding;
    const fresh = vectorsOf(await embed([row.content], 'passage'));
    if (fresh) {
      const sim = cosine(stored, fresh[0]);
      console.log(`  row ${row.id}, stored as "${row.embedding_model ?? 'null'}"`);
      console.log(`  cosine(stored, re-embedded) = ${sim.toFixed(4)}\n`);
      if (sim > 0.95) {
        console.log('  SAME SPACE. OpenRouter was routing to this very model. The stored');
        console.log('  vectors are fine — DO NOT run the sweep. Re-label and you are done:');
        console.log(`      update documents set embedding_model = '${EMBED_MODEL}';`);
      } else if (sim > 0.6) {
        console.log('  SHIFTED BUT RELATED — almost certainly the input_type change (old');
        console.log('  calls sent none, new ones send "passage"). Retrieval degrades rather');
        console.log('  than dies, so you can sweep hot: node .rag/reembed.mjs --all');
      } else {
        console.log('  DIFFERENT SPACE. Every un-swept row is unretrievable — schema.sql:186');
        console.log('  drops anything under 0.20 similarity and these score ~0.00. Sweep');
        console.log('  BEFORE announcing anything: node .rag/reembed.mjs --all');
      }
    }
  }
}

console.log(`
=== Read this before running reembed.mjs ===
--all is NOT optional any more. reembed.mjs skips ['news','india','analysis'] by
default, because those were once churn meant to be DELETED. This change re-labels
EVERY row stale, and ingest-live never revisits a stored source_url — so without
--all those rows stay stranded permanently. That is precisely the 2026-07-19
failure repeating. Either sweep with --all, or delete the churn first
(.rag/fix-mixed-embedding-space.sql section 1) and sweep what survives.
`);
