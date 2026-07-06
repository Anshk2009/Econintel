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
// upsertDoc embeds + upserts on source_url (with the publishable-column retry) —
// the same helper the open-data ingesters use.
import { upsertDoc } from './sources/_lib.mjs';

// --- Config: set these as environment variables before running ---
const DOCS_DIR = './documents';

// Chunk size in characters (~2000 ≈ 500 tokens). Overlap repeats 200 chars so a
// sentence straddling a boundary isn't cut in half and lost. These now only
// apply as the FALLBACK inside chunkText() — heading-based splitting comes first.
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

// Split text into chunks, preferring MARKDOWN HEADING boundaries.
// A chunking analysis of our case-study corpus showed heading-based splits give
// 100% clean sentence breaks (a heading always starts a new thought), while
// fixed 2000-char slicing cuts sentences mid-word. Strategy:
//   1. Split the body at every "## Heading" line (each section keeps its heading,
//      so the chunk carries its own topic label into the embedding).
//   2. Merge small neighbouring sections until adding the next would pass
//      CHUNK_SIZE — tiny sections shouldn't become one-line chunks.
//   3. Any single section still longer than CHUNK_SIZE falls back to the old
//      fixed-size overlapping split.
function chunkText(text) {
  // 1. Section per heading. The regex keeps the "## " with the section that
  //    follows it (lookahead split, so nothing is thrown away).
  const sections = text.split(/(?=^#{1,3} )/m).map(s => s.trim()).filter(Boolean);
  if (sections.length <= 1) return fixedChunks(text);   // no headings — old behaviour

  // 2. Greedily merge sections into ~CHUNK_SIZE chunks.
  const chunks = [];
  let current = '';
  for (const sec of sections) {
    if (current && (current.length + sec.length + 2) > CHUNK_SIZE) {
      chunks.push(current);
      current = sec;
    } else {
      current = current ? `${current}\n\n${sec}` : sec;
    }
  }
  if (current) chunks.push(current);

  // 3. Oversized single sections still get the fixed split.
  return chunks.flatMap(c => (c.length > CHUNK_SIZE ? fixedChunks(c) : [c]));
}

// The old fixed-size overlapping split — now the fallback.
function fixedChunks(text) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    chunks.push(text.slice(start, start + CHUNK_SIZE));
    start += CHUNK_SIZE - CHUNK_OVERLAP;
  }
  return chunks;
}

async function main() {
  // Read .md/.txt docs, skipping the template (_TEMPLATE.md) and the seed list.
  const files = (await readdir(DOCS_DIR)).filter(f =>
    (f.endsWith('.md') || f.endsWith('.txt')) && !f.startsWith('_') && f !== 'case-studies-to-seed.md'
  );

  let total = 0, failed = 0;
  for (const file of files) {
    // Per-doc resilience: one bad doc logs and is skipped instead of killing the
    // whole run, so a single hiccup never blocks the rest of the library.
    try {
      const raw = await readFile(join(DOCS_DIR, file), 'utf8');
      const { meta, body } = parseDoc(raw);
      if (!body) { console.warn(`Skipping empty: ${file}`); continue; }

      const baseUrl = meta.source_url || file;
      const chunks = chunkText(body);
      console.log(`${file}: ${chunks.length} chunks`);

      for (let i = 0; i < chunks.length; i++) {
        await upsertDoc({
          content:      chunks[i],
          source_name:  meta.source_name || file.replace(/\.(md|txt)$/, ''),
          // Make the URL unique per chunk so the source_url unique index doesn't
          // clash when one doc becomes several chunks. The "#0/#1" still opens the page.
          source_url:   chunks.length > 1 ? `${baseUrl}#${i}` : baseUrl,
          category:     meta.category || 'reference',
          published_at: meta.published_at || null,
          // These are YOUR original/curated docs (case studies, references you
          // wrote/verified) → safe to republish. Front-matter can override with
          // `publishable: false` for anything you only want used for retrieval.
          publishable:  meta.publishable ? meta.publishable !== 'false' : true,
        });
        total++;
      }
    } catch (err) {
      failed++;
      console.warn(`Skipping ${file}: ${err.message}`);
    }
  }
  console.log(`Done. Upserted ${total} chunks from ${files.length} files (${failed} failed).`);
  if (total === 0 && failed > 0) process.exit(1); // total failure → mark the run red
}

main().catch(err => { console.error(err); process.exit(1); });
