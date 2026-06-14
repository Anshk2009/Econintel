// ingest-files.mjs — load your MANUAL documents (rag/documents/*.md or *.txt)
// into the RAG library. Run with:  node ingest-files.mjs
// No npm packages: Node 18+ has fetch() built in.
//
// Each document file has YAML-style front-matter (see documents/_TEMPLATE.md):
//   ---
//   source_name: IMF — World Economic Outlook
//   source_url:  https://www.imf.org/...
//   published_at: 2026-01-01
//   category: case-study
//   ---
//   <the real text>
//
// This reads every doc, splits the body into overlapping chunks, embeds each
// chunk via OpenRouter (same model as the live ingester + chat), and upserts
// them into Supabase. Re-running updates existing rows instead of duplicating.

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

// --- Config: set these as environment variables before running ---
const OPENROUTER_EMBED_KEY = process.env.OPENROUTER_EMBED_KEY; // embeddings key
const SUPABASE_URL = process.env.SUPABASE_URL;                 // https://xxxx.supabase.co
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
const DOCS_DIR = './documents';

// Chunk size in characters (~2000 ≈ 500 tokens). Overlap repeats 200 chars so a
// sentence straddling a boundary isn't cut in half and lost.
const CHUNK_SIZE = 2000;
const CHUNK_OVERLAP = 200;

// Pull the front-matter fields + body out of one file's text.
function parseDoc(raw) {
  const m = raw.match(/^---\s*([\s\S]*?)\s*---\s*([\s\S]*)$/);
  if (!m) return { meta: {}, body: raw.trim() };   // no front-matter — treat all as body
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-z_]+):\s*(.*)$/i);
    if (kv) meta[kv[1].trim()] = kv[2].trim();
  }
  return { meta, body: m[2].trim() };
}

// Split text into overlapping chunks.
function chunkText(text) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    chunks.push(text.slice(start, start + CHUNK_SIZE));
    start += CHUNK_SIZE - CHUNK_OVERLAP;
  }
  return chunks;
}

// Embed text via OpenRouter (NVIDIA model, 2048-dim) — same as the live ingester.
async function embed(text) {
  const res = await fetch('https://openrouter.ai/api/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_EMBED_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: 'nvidia/llama-nemotron-embed-vl-1b-v2:free', input: text }),
  });
  if (!res.ok) throw new Error(`Embedding failed: ${res.status} ${await res.text()}`);
  return (await res.json()).data[0].embedding;
}

// Upsert one chunk row. merge-duplicates means re-running a file UPDATES its rows
// (matched on the unique source_url) instead of erroring on a duplicate.
async function upsertChunk(row) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/documents`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'apikey': SUPABASE_KEY,
      'Prefer': 'resolution=merge-duplicates',
    },
    body: JSON.stringify(row),
  });
  if (!res.ok) throw new Error(`Insert failed: ${res.status} ${await res.text()}`);
}

async function main() {
  // Read .md/.txt docs, skipping the template (_TEMPLATE.md) and the seed list.
  const files = (await readdir(DOCS_DIR)).filter(f =>
    (f.endsWith('.md') || f.endsWith('.txt')) && !f.startsWith('_') && f !== 'case-studies-to-seed.md'
  );

  let total = 0;
  for (const file of files) {
    const raw = await readFile(join(DOCS_DIR, file), 'utf8');
    const { meta, body } = parseDoc(raw);
    if (!body) { console.warn(`Skipping empty: ${file}`); continue; }

    const baseUrl = meta.source_url || file;
    const chunks = chunkText(body);
    console.log(`${file}: ${chunks.length} chunks`);

    for (let i = 0; i < chunks.length; i++) {
      const embedding = await embed(chunks[i]);
      await upsertChunk({
        content:      chunks[i],
        source_name:  meta.source_name || file.replace(/\.(md|txt)$/, ''),
        // Make the URL unique per chunk so the source_url unique index doesn't
        // clash when one doc becomes several chunks. The "#0/#1" still opens the page.
        source_url:   chunks.length > 1 ? `${baseUrl}#${i}` : baseUrl,
        category:     meta.category || 'reference',
        published_at: meta.published_at || null,
        embedding,
      });
      total++;
    }
  }
  console.log(`Done. Upserted ${total} chunks from ${files.length} files.`);
}

main().catch(err => { console.error(err); process.exit(1); });
