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
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY; // embeddings (SAME key as chat)
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
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
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
  const { feeds } = JSON.parse(await readFile('./feeds.json', 'utf8'));
  let added = 0, skipped = 0;

  for (const feed of feeds) {
    try {
      const xml   = await (await fetch(feed.url)).text();
      const items = parseRss(xml);
      console.log(`${feed.name}: ${items.length} items`);

      for (const item of items) {
        if (!item.url || !item.title) continue;        // skip malformed entries
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
      }
    } catch (err) {
      // One bad feed shouldn't stop the whole run.
      console.warn(`Skipping ${feed.name}: ${err.message}`);
    }
  }

  console.log(`Done. Added ${added} new items, skipped ${skipped} already stored.`);
}

main().catch(err => { console.error(err); process.exit(1); });
