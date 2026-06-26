// ingest-live.mjs — pull LIVE world news into the RAG library.
// Run with:  node ingest-live.mjs
// No npm packages: Node 18+ has fetch() built in.
//
// What it does:
//   1. Reads the list of RSS feeds from feeds.json
//   2. Fetches the newest items from each feed
//   3. Skips anything already stored (dedupe by the article URL)
//   4. Turns each new item into an embedding and saves it to Supabase
//
// Schedule it (Windows Task Scheduler / GitHub Actions cron) every few hours
// so the library always reflects what's happening in the world.

import { readFile } from 'node:fs/promises';

// --- Config: set these as environment variables before running ---
const OPENROUTER_EMBED_KEY = process.env.OPENROUTER_EMBED_KEY; // OpenRouter key for embeddings
const SUPABASE_URL   = process.env.SUPABASE_URL;          // https://xxxx.supabase.co
const SUPABASE_KEY   = process.env.SUPABASE_ANON_KEY;

// Hard per-request timeout. Node's built-in fetch() waits FOREVER by default, so
// a single slow RSS feed or a hung OpenRouter/Supabase call freezes the whole run
// until GitHub kills the job hours later (the "stuck run" symptom). AbortController
// guarantees every request gives up after TIMEOUT_MS so the loop keeps moving.
const TIMEOUT_MS = 15000;
async function fetchWithTimeout(url, options = {}, ms = TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer); // always clear so the timer can't keep the process alive
  }
}

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

// Turn text into a 2048-number embedding via OpenRouter (NVIDIA model, free).
async function embed(text) {
  const res = await fetchWithTimeout('https://openrouter.ai/api/v1/embeddings', {
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

// Has this article URL already been stored? (dedupe — don't embed the same news twice)
async function alreadyStored(url) {
  const res = await fetchWithTimeout(
    `${SUPABASE_URL}/rest/v1/documents?source_url=eq.${encodeURIComponent(url)}&select=id&limit=1`,
    { headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'apikey': SUPABASE_KEY } },
  );
  if (!res.ok) return false;               // on error, assume not stored (fail open)
  const rows = await res.json();
  return Array.isArray(rows) && rows.length > 0;
}

// Save one news item as a row in the documents table.
async function insertItem(row) {
  const post = (body) => fetchWithTimeout(`${SUPABASE_URL}/rest/v1/documents`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'apikey': SUPABASE_KEY,
    },
    body: JSON.stringify(body),
  });

  let res = await post(row);
  if (!res.ok) {
    const errText = await res.text();
    // A citeable feed sends publishable=true, which needs the publishable column
    // (migration-add-publishable.sql). If that column isn't there yet, retry once
    // WITHOUT the flag so ingestion never breaks — the row just stores as
    // non-citeable until the migration + backfill run.
    if (row.publishable !== undefined && /publishable|does not exist|PGRST204/i.test(errText)) {
      const { publishable, ...rest } = row;
      const res2 = await post(rest);
      if (res2.ok) return;
      throw new Error(`Insert failed (retry without publishable): ${res2.status} ${await res2.text()}`);
    }
    throw new Error(`Insert failed: ${res.status} ${errText}`);
  }
}

async function main() {
  // Fail loud if a required secret is missing. Without this, a blank key sends
  // "Bearer undefined" to OpenRouter/Supabase, every request 401s, and the run
  // still finishes "successfully" having added nothing — a silent green failure.
  const missing = [];
  if (!OPENROUTER_EMBED_KEY) missing.push('OPENROUTER_EMBED_KEY');
  if (!SUPABASE_URL)         missing.push('SUPABASE_URL');
  if (!SUPABASE_KEY)         missing.push('SUPABASE_ANON_KEY');
  if (missing.length) {
    console.error(`Missing required env var(s): ${missing.join(', ')}. Set them as GitHub repo Secrets.`);
    process.exit(1);
  }

  const { feeds } = JSON.parse(await readFile('./feeds.json', 'utf8'));
  let added = 0, skipped = 0, failed = 0;

  for (const feed of feeds) {
    let items;
    try {
      const xml = await (await fetchWithTimeout(feed.url)).text();
      items = parseRss(xml);
      console.log(`${feed.name}: ${items.length} items`);
    } catch (err) {
      // A dead/unreachable/slow feed shouldn't stop the whole run — the timeout
      // turns a hang into a quick error, and we skip just this feed.
      console.warn(`Feed fetch failed, skipping ${feed.name}: ${err.message}`);
      continue;
    }

    for (const item of items) {
      if (!item.url || !item.title) continue;          // skip malformed entries
      try {
        if (await alreadyStored(item.url)) { skipped++; continue; }

        // The text we embed = headline + summary. Enough for the chat to find
        // and cite the real source; keep it small to stay cheap.
        const text = `${item.title}\n${item.description}`;
        const embedding = await embed(text);

        await insertItem({
          content:      text,
          source_name:  feed.name,
          source_url:   item.url,
          category:     feed.category || 'news',
          published_at: item.date ? new Date(item.date).toISOString() : null,
          // CITEABLE primary/open-data feeds (feeds.json "citeable": true) are the
          // only ones marked publishable=true, so the chat may cite them when a
          // user asks. Everything else OMITS the field (undefined keys are dropped
          // by JSON.stringify) and stays retrieval-only via the column DEFAULT
          // (false) — never cited, and works even before the publishable column
          // exists. insertItem() also retries without the flag if the column is
          // missing, so a citeable feed can never break ingestion either.
          publishable:  feed.citeable === true ? true : undefined,
          embedding,
        });
        added++;
      } catch (err) {
        // Per-ITEM catch (was per-feed): one failed embed/insert no longer
        // skips the rest of that feed's items. Count failures so a dead
        // embeddings key/model surfaces instead of passing silently.
        failed++;
        console.warn(`  item failed (${item.url}): ${err.message}`);
      }
    }
  }

  console.log(`Done. Added ${added}, skipped ${skipped} (already stored), failed ${failed}.`);

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
