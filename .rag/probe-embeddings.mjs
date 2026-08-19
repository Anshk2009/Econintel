// probe-embeddings.mjs — which embedding endpoint actually works, and at what size?
// Run: node probe-embeddings.mjs
//
// Set whichever keys you have; missing ones are reported, not fatal:
//   OPENROUTER_EMBED_KEY   (current provider)
//   NVIDIA_API_KEY         (already used for CHAT — see MODEL_BUCKETS in functions/chat.js)
//
// WHY: embeddings are the single point of failure in this pipeline. If they stop,
// ingestion stops adding rows AND chat retrieval fails open — answers keep coming,
// ungrounded, looking normal. Chat generation already moved to NVIDIA; embeddings
// are the last thing tied to OpenRouter, so if OpenRouter billing is blocked and
// the NVIDIA key works, the dependency can go away entirely.
//
// Reports the EXACT upstream error rather than a guess, and the vector DIMENSION
// of anything that works — that number decides whether the documents.embedding
// column can stay vector(2048) or the table has to change.
import process from 'node:process';

const OR_KEY = process.env.OPENROUTER_EMBED_KEY;
const NV_KEY = process.env.NVIDIA_API_KEY;

const TIMEOUT_MS = 20000;
async function post(url, key, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await r.text();
    return { status: r.status, text };
  } catch (e) {
    return { status: 0, text: e.name === 'AbortError' ? 'timed out' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

// Two short strings: one embeds fine everywhere, and a batch proves array input
// works — which is what makes the request budget affordable.
const SAMPLE = ['India current account deficit widened in the June quarter.',
                'The central bank held the policy rate at 6.5 percent.'];

function report(label, { status, text }) {
  let dims = null, count = null;
  try {
    const j = JSON.parse(text);
    if (Array.isArray(j.data) && j.data[0]?.embedding) {
      count = j.data.length;
      dims = j.data[0].embedding.length;
    }
  } catch { /* not JSON — fall through to the raw body */ }

  if (dims) {
    console.log(`  WORKS   ${label}`);
    console.log(`          ${count} vectors returned, ${dims} dimensions` +
                (dims === 2048 ? '  <-- matches the existing vector(2048) column' : `  <-- COLUMN CHANGE NEEDED (currently 2048)`));
    return { ok: true, dims };
  }
  console.log(`  FAILS   ${label}`);
  console.log(`          HTTP ${status}: ${text.replace(/\s+/g, ' ').slice(0, 200)}`);
  return { ok: false };
}

console.log('\n=== OpenRouter (current provider) ===');
if (!OR_KEY) {
  console.log('  SKIP    OPENROUTER_EMBED_KEY not set in this shell.');
} else {
  console.log(`  key looks like: ${OR_KEY.slice(0, 8)}… (${OR_KEY.length} chars)`);
  report('nvidia/nemotron-3-embed-1b:free',
    await post('https://openrouter.ai/api/v1/embeddings', OR_KEY,
               { model: 'nvidia/nemotron-3-embed-1b:free', input: SAMPLE }));
}

console.log('\n=== NVIDIA (already serving your CHAT) ===');
if (!NV_KEY) {
  console.log('  SKIP    NVIDIA_API_KEY not set in this shell.');
  console.log('          It IS set in EdgeOne if chat has been working — copy it from there.');
} else {
  console.log(`  key looks like: ${NV_KEY.slice(0, 8)}… (${NV_KEY.length} chars)`);
  // Candidates in preference order. The embedqa models want input_type, which
  // OpenAI-shaped clients do not send — so each is tried both ways and whichever
  // shape the endpoint accepts is what the ingesters would use.
  const candidates = [
    'nvidia/nemotron-3-embed-1b',
    'nvidia/llama-3.2-nv-embedqa-1b-v2',
    'nvidia/nv-embedqa-e5-v5',
    'baai/bge-m3',
  ];
  for (const model of candidates) {
    const plain = await post('https://integrate.api.nvidia.com/v1/embeddings', NV_KEY,
                             { model, input: SAMPLE, encoding_format: 'float' });
    const r = report(model, plain);
    if (!r.ok) {
      // Retrieval-tuned models require input_type ("passage" to store, "query" to search).
      const typed = await post('https://integrate.api.nvidia.com/v1/embeddings', NV_KEY,
                               { model, input: SAMPLE, encoding_format: 'float',
                                 input_type: 'passage', truncate: 'END' });
      const r2 = report(`${model}  [with input_type: passage]`, typed);
      if (r2.ok) {
        console.log('          NOTE: this model needs input_type. Documents embed as');
        console.log('          "passage", live questions as "query" — mixing them up costs');
        console.log('          accuracy quietly, so both call sites must set it.');
      }
    }
  }
}

console.log(`
=== What to do with this ===
* OpenRouter WORKS  -> nothing to change; the block was billing, and it cleared.
* OpenRouter FAILS, an NVIDIA model WORKS at 2048 dims
    -> switch providers. One constant (EMBED_MODEL in sources/_lib.mjs), one URL,
       and the same change in retrieveContext in functions/chat.js. Then re-embed
       EVERYTHING: node reembed.mjs --all. The embedding_model column makes that
       safe and resumable, which is exactly what it was added for.
* An NVIDIA model works but NOT at 2048 dims
    -> the documents.embedding column has to be recreated at the new size, so
       every row is re-embedded from scratch. Tell me the number first.
* EVERYTHING fails -> paste the errors above; they name the real cause.
`);
