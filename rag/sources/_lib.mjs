// rag/sources/_lib.mjs — shared helpers for the data-source ingesters
// (World Bank, FRED, SEC EDGAR, OGD India). No npm packages: Node 18+ has fetch().
//
// Every doc these write is CITEABLE (publishable = true) — they are primary /
// open-data sources, unlike the commercial-news RSS which stays background-only.
import process from 'node:process';

export const OPENROUTER_EMBED_KEY = process.env.OPENROUTER_EMBED_KEY;
export const SUPABASE_URL = process.env.SUPABASE_URL;
export const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

// SEC requires a descriptive User-Agent with contact info on every request.
// Set INGEST_CONTACT (e.g. "EconIntel you@domain.com"); falls back to a generic.
export const CONTACT = process.env.INGEST_CONTACT || 'EconIntel econintelai@gmail.com';

// Hard per-request timeout so one slow/hung API can't freeze the whole run.
const TIMEOUT_MS = 20000;
export async function fetchWithTimeout(url, options = {}, ms = TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Turn text into a 2048-dim embedding — SAME model as every other ingester and
// the chat, so the vectors live in the same space.
export async function embed(text) {
  const r = await fetchWithTimeout('https://openrouter.ai/api/v1/embeddings', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${OPENROUTER_EMBED_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'nvidia/llama-nemotron-embed-vl-1b-v2:free', input: text }),
  });
  if (!r.ok) throw new Error(`Embedding failed: ${r.status} ${await r.text()}`);
  return (await r.json()).data[0].embedding;
}

// Embed + upsert one citeable document. Dedupes/updates on source_url (the unique
// index). Retries WITHOUT `publishable` if that column doesn't exist yet, so a
// pre-migration run still ingests (the migration backfill flags it later).
export async function upsertDoc({ content, source_name, source_url, category, published_at = null, publishable = true }) {
  const embedding = await embed(content);
  const row = { content, source_name, source_url, category, published_at, publishable, embedding };
  const post = (body) => fetchWithTimeout(`${SUPABASE_URL}/rest/v1/documents?on_conflict=source_url`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'apikey': SUPABASE_KEY,
      'Prefer': 'resolution=merge-duplicates',
    },
    body: JSON.stringify(body),
  });

  let res = await post(row);
  if (!res.ok) {
    const errText = await res.text();
    if (row.publishable !== undefined && /publishable|does not exist|PGRST204/i.test(errText)) {
      const { publishable: _drop, ...rest } = row;
      const res2 = await post(rest);
      if (res2.ok) return;
      throw new Error(`Upsert failed (retry without publishable): ${res2.status} ${await res2.text()}`);
    }
    throw new Error(`Upsert failed: ${res.status} ${errText}`);
  }
}

// Throw a clear error if a required env var (e.g. an API key) is missing.
export function requireEnv(names) {
  const missing = names.filter(n => !process.env[n]);
  if (missing.length) throw new Error(`Missing env var(s): ${missing.join(', ')}`);
}
