// ingest-live.mjs — pull LIVE world news into the RAG library.
// Run with:  node ingest-live.mjs
// No npm packages: Node 18+ has fetch() built in.
//
// What it does:
//   1. Reads the list of RSS feeds from feeds.json
//   2. Fetches ALL feeds in parallel (a slow feed no longer delays the others)
//   3. Skips anything already stored (ONE dedupe query per feed, not per item)
//   4. Embeds new items in BATCHES of 10 (one API call for 10 items) and saves
//      them to Supabase in one insert per batch
//
// Schedule it (Windows Task Scheduler / GitHub Actions cron) every few hours
// so the library always reflects what's happening in the world.

import { readFile } from 'node:fs/promises';
// embedBatch() + fetchWithTimeout() are shared with the data-source ingesters.
import { embedBatch, fetchWithTimeout } from './sources/_lib.mjs';

// --- Config: set these as environment variables before running ---
const SUPABASE_URL   = process.env.SUPABASE_URL;          // https://xxxx.supabase.co
const SUPABASE_KEY   = process.env.SUPABASE_ANON_KEY;

// Take at most this many items per feed per run. Bounds embedding cost and
// keeps one hyperactive feed from flooding the library in a single run —
// the cron runs every few hours, so anything missed is picked up next time.
const MAX_ITEMS_PER_FEED = 25;

// Refuse to parse feeds bigger than this. Our regex parser scans the whole
// text; a malformed/hostile multi-megabyte response could make that scan
// crawl. 2 MB is ~10x a normal RSS feed.
const MAX_FEED_BYTES = 2 * 1024 * 1024;

// How many items to embed + insert per batch (one embeddings API call each).
const BATCH_SIZE = 10;

// Read one RSS/XML feed and pull out its items as {title, url, description, date}.
// This is a lightweight regex parser — good enough for standard RSS, no library.
function parseRss(xml) {
  const items = [];
  // Each news entry sits inside <item>...</item> (RSS) or <entry>...</entry> (Atom).
  const blocks = xml.match(/<(item|entry)[\s\S]*?<\/(item|entry)>/g) || [];
  for (const block of blocks) {
    items.push({
      title:       pick(block, 'title'),
      url:         pickLink(block),
      description: stripTags(pick(block, 'description') || pick(block, 'summary') || ''),
      date:        pick(block, 'pubDate') || pick(block, 'published') || pick(block, 'updated') || '',
    });
  }
  return items;
}

// Grab the text inside the first <tag>...</tag>, handling <![CDATA[...]]> wrappers.
function pick(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  if (!m) return '';
  return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
}

// Links differ between RSS (<link>url</link>) and Atom (<link href="url"/>).
function pickLink(block) {
  const rss = block.match(/<link[^>]*>([\s\S]*?)<\/link>/i);
  if (rss && rss[1].trim()) return rss[1].trim();
  const atom = block.match(/<link[^>]*href="([^"]+)"/i);
  return atom ? atom[1] : '';
}

// Remove any leftover HTML tags from a description.
function stripTags(s) {
  return s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

// Which of these article URLs are already stored? ONE query for the whole list
// (the old version asked Supabase once PER ITEM — 25 items = 25 round trips).
// Returns a Set of the URLs that already exist.
async function findStored(urls) {
  if (urls.length === 0) return new Set();
  // PostgREST "in" filter: source_url=in.("url1","url2",...) — each value
  // double-quoted (with internal quotes escaped), whole thing URL-encoded.
  const list = urls.map(u => `"${u.replace(/"/g, '\\"')}"`).join(',');
  const res = await fetchWithTimeout(
    `${SUPABASE_URL}/rest/v1/documents?source_url=in.(${encodeURIComponent(list)})&select=source_url`,
    { headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'apikey': SUPABASE_KEY } },
  );
  if (!res.ok) return new Set();            // on error, assume none stored (fail open;
                                            // the insert's on_conflict still dedupes)
  const rows = await res.json();
  return new Set(rows.map(r => r.source_url));
}

// Insert a BATCH of rows in one request. on_conflict + ignore-duplicates makes
// it idempotent: if a row slipped past the dedupe check (or two runs race),
// Postgres just skips it instead of erroring the whole batch.
async function insertRows(rows) {
  const post = (body) => fetchWithTimeout(`${SUPABASE_URL}/rest/v1/documents?on_conflict=source_url`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'apikey': SUPABASE_KEY,
      'Prefer': 'resolution=ignore-duplicates',
    },
    body: JSON.stringify(body),
  });

  let res = await post(rows);
  if (!res.ok) {
    const errText = await res.text();
    // A citeable feed sends publishable=true, which needs the publishable column
    // (migration-add-publishable.sql). If that column isn't there yet, retry once
    // WITHOUT the flag so ingestion never breaks — the rows just store as
    // non-citeable until the migration + backfill run.
    if (/publishable|does not exist|PGRST204/i.test(errText)) {
      const stripped = rows.map(({ publishable, ...rest }) => rest);
      const res2 = await post(stripped);
      if (res2.ok) return;
      throw new Error(`Insert failed (retry without publishable): ${res2.status} ${await res2.text()}`);
    }
    throw new Error(`Insert failed: ${res.status} ${errText}`);
  }
}

// Fetch + parse ONE feed. Returns its new (not-yet-stored) items, each tagged
// with the feed it came from. Any failure returns [] so one dead feed never
// hurts the rest of the run.
async function collectFeed(feed) {
  let items;
  try {
    const res = await fetchWithTimeout(feed.url);
    const xml = await res.text();
    if (xml.length > MAX_FEED_BYTES) throw new Error(`feed too large (${xml.length} bytes)`);
    items = parseRss(xml).slice(0, MAX_ITEMS_PER_FEED);
    console.log(`${feed.name}: ${items.length} items`);
  } catch (err) {
    console.warn(`Feed fetch failed, skipping ${feed.name}: ${err.message}`);
    return [];
  }

  const valid = items.filter(i => i.url && i.title);       // skip malformed entries
  try {
    const stored = await findStored(valid.map(i => i.url));
    return valid.filter(i => !stored.has(i.url)).map(i => ({ ...i, feed }));
  } catch {
    return valid.map(i => ({ ...i, feed }));               // dedupe failed → let
  }                                                        // on_conflict handle it
}

async function main() {
  // Fail loud if a required secret is missing. Without this, a blank key sends
  // "Bearer undefined" to OpenRouter/Supabase, every request 401s, and the run
  // still finishes "successfully" having added nothing — a silent green failure.
  const missing = [];
  if (!process.env.OPENROUTER_EMBED_KEY) missing.push('OPENROUTER_EMBED_KEY');
  if (!SUPABASE_URL)         missing.push('SUPABASE_URL');
  if (!SUPABASE_KEY)         missing.push('SUPABASE_ANON_KEY');
  if (missing.length) {
    console.error(`Missing required env var(s): ${missing.join(', ')}. Set them as GitHub repo Secrets.`);
    process.exit(1);
  }

  const { feeds } = JSON.parse(await readFile('./feeds.json', 'utf8'));

  // ALL feeds fetch + dedupe in parallel (each one already catches its own
  // errors, so allSettled's rejected branch should never fire — belt and braces).
  const settled = await Promise.allSettled(feeds.map(collectFeed));
  const fresh = settled.flatMap(s => (s.status === 'fulfilled' ? s.value : []));
  console.log(`\n${fresh.length} new items to embed across ${feeds.length} feeds.`);

  // Embed + insert in batches: one embeddings call + one insert per BATCH_SIZE
  // items, instead of one of each PER item.
  let added = 0, failed = 0;
  for (let i = 0; i < fresh.length; i += BATCH_SIZE) {
    const batch = fresh.slice(i, i + BATCH_SIZE);
    try {
      // The text we embed = headline + summary. Enough for the chat to find
      // and cite the real source; keep it small to stay cheap.
      const embeddings = await embedBatch(batch.map(it => `${it.title}\n${it.description}`));
      const rows = batch.map((it, j) => ({
        content:      `${it.title}\n${it.description}`,
        source_name:  it.feed.name,
        source_url:   it.url,
        category:     it.feed.category || 'news',
        published_at: it.date ? new Date(it.date).toISOString() : null,
        // CITEABLE primary/open-data feeds (feeds.json "citeable": true) are the
        // only ones marked publishable=true, so the chat may cite them when a
        // user asks. Everything else stays retrieval-only BACKGROUND (column
        // DEFAULT false) — never cited.
        publishable:  it.feed.citeable === true ? true : undefined,
        embedding:    embeddings[j],
      }));
      await insertRows(rows);
      added += rows.length;
    } catch (err) {
      // Per-BATCH catch: one failed embed/insert costs at most BATCH_SIZE items,
      // never the whole run. Count failures so a dead embeddings key/model
      // surfaces instead of passing silently.
      failed += batch.length;
      console.warn(`  batch failed (${batch.length} items): ${err.message}`);
    }
  }

  console.log(`Done. Added ${added}, failed ${failed}.`);

  // If items failed AND nothing new was added, ingestion is genuinely broken
  // (embeddings key/model dead, Supabase unreachable, etc.) — exit non-zero so
  // the GitHub Actions run shows RED and notifies you, instead of a green check
  // that quietly added zero news. (0 added with 0 failed = simply no new items,
  // which is fine and stays green.)
  if (failed > 0 && added === 0) {
    console.error('Every attempted item failed and nothing was added — failing the run so it is visible.');
    process.exit(1);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
