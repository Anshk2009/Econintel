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

// Headers for fetching public RSS/Atom feeds.
// Node's fetch defaults to `User-Agent: node`, which many outlets' CDNs answer
// with 403 or an HTML interstitial. A UA that DECLARES itself a bot is blocked
// just as hard — pib.gov.in, moneycontrol.com and business-standard.com all
// return 403 to "…EconIntelBot/1.0…" and 200 to this string (verified
// 2026-07-19). So we send a normal browser UA, which is what ordinary RSS
// readers effectively do. Keep it here so the ingester and the health check
// can never drift apart and report different results.
export const FEED_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8',
};

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

// The embedding model, named ONCE. Every ingester, the repair job and the
// `documents.embedding_model` column all read this constant, so "which space is
// this vector in" has exactly one answer in the codebase.
//
// Changing it is still a data migration — but it is now a SELF-HEALING one.
// Every row records the model that embedded it, so `unchanged()` below refuses
// to skip a row whose model no longer matches, and reembed.mjs sweeps up the
// backlog. Before this column existed, changing this string (commit 8280329,
// 2026-07-19) silently stranded 4,364 rows — 29% of the library — in a dead
// coordinate space for a month, because cosine distance between two models'
// vectors is just noise and nothing anywhere recorded which model a row used.
//
// After changing it: run `node reembed.mjs` until it reports 0 remaining.
export const EMBED_MODEL = 'nvidia/nemotron-3-embed-1b:free';

// Turn text into a 2048-dim embedding — SAME model as every other ingester and
// the chat, so the vectors live in the same space.
export async function embed(text) {
  return (await embedBatch([text]))[0];
}

// Embed MANY texts in one API call (the embeddings endpoint accepts an array).
// One request for 10 items instead of 10 requests — faster ingestion and far
// fewer chances to trip OpenRouter's free-tier rate limit. Returns embeddings
// in the same order as `texts` (sorted by the response's index field, since
// the API doesn't guarantee response order).
// ── THE EMBEDDING REQUEST BUDGET ────────────────────────────────────────────
// Enforced HERE, inside the one function every ingester ultimately calls, so no
// script can forget it. That matters most for the open-data path: upsertDoc()
// embeds ONE document per call, so World Bank alone (16 countries x 12
// indicators) is 192 requests — nearly 4x the entire free daily allowance, spent
// before ingest-live or live chat get a look in.
//
// ON THE NUMBER: it is a ceiling, not a measured limit, and it should not be set
// tighter than what already worked. Before any budget existed, ingest-live ran
// uncapped — 23 feeds, batches of 10, up to ~58 requests per run — for months
// without exhausting anything. So quota has never been the binding constraint
// here, and a budget that stops ingestion is worse than no budget at all.
// (An earlier revision of this file put the default at 3, on a "~50 requests
// per day" figure carried over from the CHAT model's free pool. That number was
// never verified for embeddings and the evidence contradicts it.)
// 20 is therefore comfortably below observed-working behaviour, while still
// guaranteeing ingestion cannot run away with a key that live chat depends on.
export const EMBED_BUDGET = Number(process.env.INGEST_EMBED_BUDGET || 20);
let embedBudget = EMBED_BUDGET;
export const embedBudgetLeft = () => embedBudget;
// For deliberate one-off jobs (reembed.mjs) that carry their own, larger budget.
export const setEmbedBudget = (n) => { embedBudget = n; };

export async function embedBatch(texts) {
  if (embedBudget <= 0) {
    const e = new Error(`Embedding budget for this run is exhausted (INGEST_EMBED_BUDGET=${EMBED_BUDGET}). Nothing was requested, so no allowance was spent.`);
    e.budget = true;   // distinct from err.quota: we stopped ourselves, upstream did not stop us
    throw e;
  }
  embedBudget--;
  const r = await fetchWithTimeout('https://openrouter.ai/api/v1/embeddings', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${OPENROUTER_EMBED_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
  });
  if (!r.ok) {
    const body = await r.text();
    const err = new Error(`Embedding failed: ${r.status} ${body}`);
    // 402 = out of credits, 429 = daily/minute request cap. Tagged so callers can
    // tell "we ran out of allowance today" (expected, wait for the reset) from
    // "something is broken" (investigate). Treating the two the same is how you
    // end up with a workflow that is red every three hours and therefore unread.
    err.quota = r.status === 402 || r.status === 429;
    throw err;
  }
  const data = (await r.json()).data;
  return data.sort((a, b) => a.index - b.index).map(d => d.embedding);
}

// Embed + upsert one citeable document. Dedupes/updates on source_url (the unique
// index). Retries WITHOUT `publishable` if that column doesn't exist yet, so a
// pre-migration run still ingests (the migration backfill flags it later).
export async function upsertDoc({ content, source_name, source_url, category, published_at = null, publishable = true }) {
  // QUOTA GUARD — check BEFORE embedding, not after.
  // The open-data ingesters re-run daily over stable source_urls (World Bank
  // country x indicator, FRED series...), but the underlying data changes
  // annually or monthly. Embedding first meant ~70 requests a day spent
  // rewriting byte-identical rows. The embeddings key is a FREE OpenRouter
  // model with a hard daily request cap that the CHAT also draws on, so wasted
  // ingest requests translate directly into failed retrieval for real users.
  // One cheap Supabase GET (effectively unmetered) buys back one embed call.
  if (await unchanged(source_url, content)) return { skipped: true };

  // Budget gone: return quietly instead of throwing. The open-data sources call
  // this in tight loops and each would log its own failure — 192 identical error
  // lines that look like a broken run when the truth is "we deliberately stopped
  // spending". Nothing is lost: source_url is stable, so the next run retries it.
  if (embedBudgetLeft() <= 0) return { skipped: true, reason: 'budget' };

  const embedding = await embed(content);
  const row = { content, source_name, source_url, category, published_at, publishable, embedding,
                embedding_model: EMBED_MODEL };
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
    // Pre-migration databases may lack `publishable` OR `embedding_model`; drop
    // both and retry so ingestion never blocks on a column that is not there yet.
    if (/publishable|embedding_model|does not exist|PGRST204/i.test(errText)) {
      const { publishable: _p, embedding_model: _m, ...rest } = row;
      const res2 = await post(rest);
      if (res2.ok) return;
      throw new Error(`Upsert failed (retry without publishable): ${res2.status} ${await res2.text()}`);
    }
    throw new Error(`Upsert failed: ${res.status} ${errText}`);
  }
}

// RETENTION. Nothing here ever deleted a row, so the library only grew — and at
// 2048 float4 dimensions every row costs ~8 KB of vector alone. 43 feeds polled
// 8x a day would cross Supabase's 500 MB free-tier ceiling within months, and
// the vector column has NO index (pgvector's HNSW caps at 2000 dims, this model
// emits 2048), so every search is a sequential scan whose cost is linear in row
// count. Unbounded growth is therefore both a storage cliff AND a latency ramp.
//
// The windows differ because the rows are worth different things. A commercial
// news blurb is superseded within weeks and its feed dropped it long ago. A
// central-bank press release or an NBER paper stays referenceable for years.
// Case studies, open data and anything hand-written are never pruned.
const RETENTION_DAYS = {
  // churn: headlines + syndicated summaries from commercial press
  churn:       90,
  // institutional: central banks, statistical agencies, open-access research
  institution: 365,
};
const CHURN_CATEGORIES       = ['news', 'india', 'analysis'];
const INSTITUTION_CATEGORIES = ['institution', 'research'];

// Delete rows past their window. Best-effort: logs and returns on failure rather
// than throwing, because a failed cleanup must never mark an otherwise good
// ingestion run red. Safe to run repeatedly — it is a no-op once caught up.
export async function prune() {
  const cutoff = (days) => new Date(Date.now() - days * 86400_000).toISOString();
  const del = async (categories, days) => {
    const list = categories.map(c => `"${c}"`).join(',');
    // published_at=lt.<cutoff> deliberately leaves undated rows alone — we
    // cannot know their age, and deleting on a guess loses real material.
    const url = `${SUPABASE_URL}/rest/v1/documents`
      + `?category=in.(${encodeURIComponent(list)})`
      + `&published_at=lt.${encodeURIComponent(cutoff(days))}`;
    const r = await fetchWithTimeout(url, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'apikey': SUPABASE_KEY,
        'Prefer': 'count=exact',                 // Content-Range tells us how many went
      },
    });
    if (!r.ok) { console.warn(`  prune(${categories.join('/')}) failed: ${r.status}`); return 0; }
    const range = r.headers.get('content-range') || '';   // e.g. "0-11/12"
    return Number(range.split('/')[1]) || 0;
  };

  try {
    const churn = await del(CHURN_CATEGORIES, RETENTION_DAYS.churn);
    const inst  = await del(INSTITUTION_CATEGORIES, RETENTION_DAYS.institution);
    console.log(`prune: removed ${churn} churn rows (>${RETENTION_DAYS.churn}d) `
              + `and ${inst} institutional rows (>${RETENTION_DAYS.institution}d)`);
  } catch (e) {
    console.warn(`prune skipped: ${e.message}`);
  }
}

// Is this source_url already stored with byte-identical content AND embedded by
// the model we are running now?
//
// The model check is not a refinement, it is the point. Content-only skipping
// looked correct and was actively harmful: the 66 stranded World Bank rows have
// content that never changes, so a content-only guard would have skipped them on
// every daily run forever — the quota optimisation would have made the dead
// embedding space PERMANENT for exactly the rows that self-heal today.
//
// Returns false on ANY doubt (row missing, request failed, bad JSON, no model
// recorded) so the caller embeds and upserts as before. This is a cost
// optimisation and it must never be the reason a row stays broken.
async function unchanged(source_url, content) {
  try {
    const r = await fetchWithTimeout(
      `${SUPABASE_URL}/rest/v1/documents?source_url=eq.${encodeURIComponent(source_url)}&select=content,embedding_model&limit=1`,
      { headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'apikey': SUPABASE_KEY } },
    );
    if (!r.ok) return false;
    const rows = await r.json();
    if (!Array.isArray(rows) || rows.length !== 1) return false;
    // A null embedding_model means the row predates the column, i.e. it may well
    // be from the old space. Re-embed it rather than trust it.
    return rows[0].content === content && rows[0].embedding_model === EMBED_MODEL;
  } catch {
    return false;
  }
}

// Throw a clear error if a required env var (e.g. an API key) is missing.
export function requireEnv(names) {
  const missing = names.filter(n => !process.env[n]);
  if (missing.length) throw new Error(`Missing env var(s): ${missing.join(', ')}`);
}
