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

// Has this article URL already been stored? (dedupe — don't embed the same news twice)
async function alreadyStored(url) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/documents?source_url=eq.${encodeURIComponent(url)}&select=id&limit=1`,
    { headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'apikey': SUPABASE_KEY } },
  );
  if (!res.ok) return false;               // on error, assume not stored (fail open)
  const rows = await res.json();
  return Array.isArray(rows) && rows.length > 0;
}

// Save one news item as a row in the documents table.
async function insertItem(row) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/documents`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'apikey': SUPABASE_KEY,
    },
    body: JSON.stringify(row),
  });
  if (!res.ok) throw new Error(`Insert failed: ${res.status} ${await res.text()}`);
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
      const xml = await (await fetch(feed.url)).text();
      items = parseRss(xml);
      console.log(`${feed.name}: ${items.length} items`);
    } catch (err) {
      // A dead/unreachable feed shouldn't stop the whole run — skip just it.
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
