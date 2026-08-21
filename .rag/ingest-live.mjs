// ingest-live.mjs — pull LIVE world news into the RAG library.
// Run with:  node ingest-live.mjs
// No npm packages: Node 18+ has fetch() built in.
//
// What it does:
//   1. Reads the list of RSS feeds from feeds.json
//   2. Fetches ALL feeds in parallel (a slow feed no longer delays the others)
//   3. Skips anything already stored (ONE dedupe query per feed, not per item)
//   4. Embeds new items in batches sized by TOTAL CHARACTERS (see MAX_BATCH_CHARS
//      — the model's context window is shared across a batch) and saves them to
//      Supabase in one insert per batch
//
// Dry run, no keys and no cost:  node .rag/ingest-live.mjs --dry-run
//
// Schedule it (Windows Task Scheduler / GitHub Actions cron) every few hours
// so the library always reflects what's happening in the world.

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
// embedBatch() + fetchWithTimeout() are shared with the data-source ingesters.
import { embedBatch, fetchWithTimeout, FEED_HEADERS, EMBED_MODEL, EMBED_BUDGET,
         SUPABASE_URL, SUPABASE_KEY, USING_SERVICE_ROLE } from './sources/_lib.mjs';

// --- Config: set these as environment variables before running ---
// Credentials come from sources/_lib.mjs, which prefers a service-role key when
// one is set and falls back to anon. Imported rather than re-read from env so
// this file cannot end up authenticating as a different role than the shared
// helpers it calls (findStored here, prune/upsertDoc there).

// Take at most this many items per feed per run. Bounds embedding cost and
// keeps one hyperactive feed from flooding the library in a single run —
// the cron runs every few hours, so anything missed is picked up next time.
const MAX_ITEMS_PER_FEED = 25;

// Refuse to parse feeds bigger than this. Our regex parser scans the whole
// text; a malformed/hostile multi-megabyte response could make that scan crawl.
// Raised 2 MB -> 6 MB: NY Fed Liberty Street Economics syndicates FULL articles
// rather than summaries and weighs 2.8 MB, so the old ceiling silently dropped a
// primary source every run. The guard is against a pathological response, not
// against a wordy publisher, and per-item truncation (MAX_ITEM_CHARS) already
// bounds what a fat feed can cost downstream.
const MAX_FEED_BYTES = 6 * 1024 * 1024;

// Upper bound on items per embedding request. Requests, not tokens, are what the
// free tier caps, so bigger batches are cheaper — but see MAX_BATCH_CHARS: this
// is only the CEILING, and the character budget usually binds first.
const BATCH_SIZE = 25;

// Hard cap on the text embedded for ONE item. A few feeds syndicate entire
// articles rather than a summary; without this, one of them sets the size of the
// whole request. Stored `content` is NOT truncated — only the embedded text is.
const MAX_ITEM_CHARS = 2000;

// Hard cap on the text in ONE embedding request. THE MODEL'S CONTEXT WINDOW IS
// THE REAL LIMIT AND IT IS SHARED ACROSS THE WHOLE BATCH — exceeding it returns
// an error for every item in that request, not a truncated vector.
// nemotron-3-embed-1b has an 8,192-token window. 12,000 characters is ~3,000
// tokens at 4 chars/token, or ~3,430 at the 3.5 that dense academic text really
// costs — roughly 40% of the window, leaving room for a feed that gets wordier
// without warning. Raising this trades that safety margin for fewer requests.
const MAX_BATCH_CHARS = 12000;

// Hard ceiling on embedding requests per run. The embeddings key is a free
// OpenRouter model with a daily REQUEST cap, and functions/chat.js draws on the
// SAME key to embed every user question. Ingestion must therefore never be able
// to eat the whole day's allowance — a starved chat fails open and answers with
// no sources at all, which is the exact failure this pipeline exists to prevent.
//
// It is a CEILING that keeps ingestion from monopolising a key live chat needs —
// not a fix for a limit anyone has hit. Ingestion ran uncapped for months at
// roughly twice this rate without trouble, so setting it lower "to be safe"
// simply stops the library growing. See the note at EMBED_BUDGET in
// sources/_lib.mjs. Override per-workflow with INGEST_EMBED_BUDGET.
//
// The number itself lives in sources/_lib.mjs, which enforces it inside
// embedBatch() as a backstop for every ingester. Imported rather than re-read
// from env so the two can never disagree about what the budget is.
const MAX_EMBED_REQUESTS_PER_RUN = EMBED_BUDGET;

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
    if (/publishable|embedding_model|does not exist|PGRST204/i.test(errText)) {
      const stripped = rows.map(({ publishable, embedding_model, ...rest }) => rest);
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
    // FEED_HEADERS sends a real browser User-Agent — Node's default (`node`) gets
    // 403'd by many outlets' CDNs, so the feed looks dead while the URL is fine.
    // See _lib.mjs for why the UA must not announce itself as a bot.
    // redirect:'follow' is the default, stated so a moved feed keeps working.
    const res = await fetchWithTimeout(feed.url, { redirect: 'follow', headers: FEED_HEADERS });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    // A blocked/moved feed often answers 200 with an HTML page. Treat that as a
    // failure so it shows up in the log instead of silently parsing to 0 items.
    if (!/<(\?xml|rss|feed)\b/i.test(xml.slice(0, 500))) throw new Error('not XML (blocked or moved?)');
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

// The text sent to the embedding model for one item: headline + summary, capped.
// The cap is separate from the stored `content` on purpose — an item longer than
// this is still stored in full for the chat to read, only its VECTOR is computed
// from the opening MAX_ITEM_CHARS. A feed that syndicates whole articles (some
// do) must not be able to blow the context window on its own.
// RSS dates are whatever the publisher felt like emitting. `new Date(x)` returns
// an Invalid Date for anything it cannot parse, and `.toISOString()` then THROWS
// — which killed the entire batch, not just the offending item. Two batches were
// lost to this on 2026-08-21. An undated row is fine (published_at is nullable
// and the chat renders "date unknown"); a thrown exception is not.
export function toISO(value) {
  if (!value) return null;
  const t = new Date(value);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

export function embedTextOf(it) {
  return `${it.title}\n${it.description}`.slice(0, MAX_ITEM_CHARS);
}

// Group items into embedding requests by TOTAL SIZE, not by a fixed count.
//
// A fixed count was the bug. BATCH_SIZE went 10 -> 25 in the same commit that
// added arXiv and NBER, whose items are 1,500-2,000-character academic
// abstracts. Measured 2026-08-21: 25 arXiv items = 32,162 chars, roughly 8,000
// tokens at 4 chars/token against this model's 8,192-token window — and dense
// academic text tokenizes nearer 3.5, putting it over. Batches are slices of one
// flat array, so a batch straddling NBER and arXiv (adjacent in feeds.json) was
// the worst case of all. Every such request was rejected, and a fixed count
// cannot anticipate that because it never looks at how long the items are.
//
// Counting characters makes the batch adapt to the content: many short wire
// headlines still ride together, a run of long abstracts splits automatically.
export function makeBatches(items, maxChars = MAX_BATCH_CHARS, maxItems = BATCH_SIZE) {
  const batches = [];
  let current = [], chars = 0;
  for (const it of items) {
    const size = embedTextOf(it).length;
    // Close the current batch if adding this item would breach either limit.
    // `current.length` guards against an empty batch when one item exceeds
    // maxChars by itself — it can't, since MAX_ITEM_CHARS < MAX_BATCH_CHARS,
    // but the check keeps that true if either constant is ever changed.
    if (current.length && (current.length >= maxItems || chars + size > maxChars)) {
      batches.push(current);
      current = []; chars = 0;
    }
    current.push(it);
    chars += size;
  }
  if (current.length) batches.push(current);
  return batches;
}

// --dry-run: fetch and parse every feed, and plan the embedding requests, but
// call neither the embeddings API nor Supabase. Costs nothing, needs no secrets,
// and answers "is the pipeline healthy?" without waiting for a cron or burning
// allowance to find out. Everything upstream of the paid call is exercised for
// real — fetch, parse, item validity, batch sizing — which is where the 2026-08
// outage actually lived.
const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  // Fail loud if a required secret is missing. Without this, a blank key sends
  // "Bearer undefined" to OpenRouter/Supabase, every request 401s, and the run
  // still finishes "successfully" having added nothing — a silent green failure.
  const missing = [];
  if (!process.env.OPENROUTER_EMBED_KEY) missing.push('OPENROUTER_EMBED_KEY');
  if (!SUPABASE_URL)         missing.push('SUPABASE_URL');
  if (!SUPABASE_KEY)         missing.push('SUPABASE_ANON_KEY or SUPABASE_SERVICE_ROLE_KEY');
  if (missing.length) {
    // A dry run touches neither API, so missing secrets are expected — say so
    // and carry on, instead of refusing to do the part that needs no keys.
    if (DRY_RUN) {
      console.log(`(dry run — no secrets needed; ${missing.join(', ')} not set, so the dedupe query is skipped and every item counts as new)\n`);
    } else {
      console.error(`Missing required env var(s): ${missing.join(', ')}. Set them as GitHub repo Secrets.`);
      process.exit(1);
    }
  }

  // Say which role we authenticated as. harden-rls.sql tells you to confirm this
  // line reads service_role BEFORE enabling RLS — get the order wrong and every
  // insert fails 42501, which is exactly how ingestion broke on 2026-08-21.
  console.log(`Supabase role: ${USING_SERVICE_ROLE ? 'service_role (RLS bypassed)' : 'anon (requires RLS off, or an insert policy)'}`);

  // Resolved relative to THIS FILE, not the working directory — the workflow
  // sets `working-directory: .rag`, but a human running
  // `node .rag/ingest-live.mjs --dry-run` from the repo root got ENOENT.
  // check-feeds.mjs already resolved it this way; this file was the odd one out.
  const { feeds } = JSON.parse(await readFile(new URL('./feeds.json', import.meta.url), 'utf8'));

  // ALL feeds fetch + dedupe in parallel (each one already catches its own
  // errors, so allSettled's rejected branch should never fire — belt and braces).
  const settled = await Promise.allSettled(feeds.map(collectFeed));
  const fresh = settled.flatMap(s => (s.status === 'fulfilled' ? s.value : []));
  console.log(`\n${fresh.length} new items to embed across ${feeds.length} feeds.`);

  // Embed + insert in batches: one embeddings call + one insert per BATCH_SIZE
  // items, instead of one of each PER item.
  // FEED ORDER IS PRIORITY ORDER. allSettled preserves input order, so `fresh`
  // comes back grouped by feed in the order feeds.json lists them — and on a
  // small budget only the first few batches get embedded. feeds.json therefore
  // lists central banks, statistical agencies and research FIRST, commercial
  // press last, so a starved run still ingests the primary sources the product's
  // claim rests on. Reordering that file silently reprioritises the corpus.
  let added = 0, failed = 0, requests = 0, deferred = 0, quotaHit = false;
  for (const batch of makeBatches(fresh)) {
    // Budget exhausted: stop cleanly rather than burn the chat's allowance.
    // These items are NOT lost — they were never inserted, so the next run's
    // dedupe check still sees them as new and picks them up.
    if (requests >= MAX_EMBED_REQUESTS_PER_RUN) { deferred += batch.length; continue; }
    requests++;
    if (DRY_RUN) {
      // Report the plan and the margin. `chars` is what the outage was about:
      // the model's context window is shared across the batch, so this number,
      // not the item count, is what has to stay inside it.
      const chars = batch.reduce((a, it) => a + embedTextOf(it).length, 0);
      const feedsIn = [...new Set(batch.map(b => b.feed.name))];
      console.log(`  request ${String(requests).padStart(2)}: ${String(batch.length).padStart(2)} items, ` +
                  `${String(chars).padStart(6)} chars (~${Math.round(chars / 3.5)} tokens, ` +
                  `${Math.round(chars / 3.5 / 8192 * 100)}% of window) — ${feedsIn.join(', ')}`);
      added += batch.length;
      continue;
    }
    try {
      // The text we embed = headline + summary. Enough for the chat to find
      // and cite the real source; keep it small to stay cheap.
      const embeddings = await embedBatch(batch.map(embedTextOf));
      const rows = batch.map((it, j) => ({
        content:      `${it.title}\n${it.description}`,
        source_name:  it.feed.name,
        source_url:   it.url,
        category:     it.feed.category || 'news',
        published_at: toISO(it.date),
        // ALWAYS a boolean, never undefined. PostgREST bulk insert requires every
        // object in the array to have the SAME KEYS ("All object keys must match",
        // PGRST102), and JSON.stringify DROPS undefined keys — so the old
        // `? true : undefined` silently produced two different row shapes, and any
        // batch spanning a citeable and a non-citeable feed was rejected whole.
        // Sizing batches by characters made cross-feed batches the norm, which is
        // what turned a latent bug into every-run breakage.
        // true = we may REPUBLISH it (gov / central bank / open research);
        // false = retrieval and attribution only. Both are cited to the reader.
        publishable:  it.feed.citeable === true,
        embedding:    embeddings[j],
        // Stamp the space this vector lives in, so a future model change is a
        // detectable, repairable event instead of a silent third of the library
        // going unreachable (see EMBED_MODEL in sources/_lib.mjs).
        embedding_model: EMBED_MODEL,
      }));
      await insertRows(rows);
      added += rows.length;
    } catch (err) {
      // Per-BATCH catch: one failed embed/insert costs at most BATCH_SIZE items,
      // never the whole run. Count failures so a dead embeddings key/model
      // surfaces instead of passing silently.
      failed += batch.length;
      console.warn(`  batch failed (${batch.length} items): ${err.message}`);
      // Out of allowance: every remaining batch would fail identically, and each
      // attempt still costs a request. Stop now — retrying just digs deeper.
      if (err.quota) { quotaHit = true; break; }
    }
  }

  if (DRY_RUN) {
    console.log(`\nDRY RUN — nothing embedded, nothing written.`);
    console.log(`Would have made ${requests} embedding request(s) for ${added} items` +
                (deferred ? `, deferring ${deferred} to the next run (budget ${MAX_EMBED_REQUESTS_PER_RUN})` : '') + '.');
    console.log('Any request above ~100% of window is the failure mode that broke ingestion in August.');
    return;
  }

  console.log(`Done. Added ${added}, failed ${failed}, embed requests ${requests}/${MAX_EMBED_REQUESTS_PER_RUN}` +
              (deferred ? `, deferred ${deferred} to the next run (budget reached)` : '.'));

  // If items failed AND nothing new was added, ingestion is genuinely broken
  // (embeddings key/model dead, Supabase unreachable, etc.) — exit non-zero so
  // the GitHub Actions run shows RED and notifies you, instead of a green check
  // that quietly added zero news. (0 added with 0 failed = simply no new items,
  // which is fine and stays green.)
  // Quota exhaustion is a KNOWN, EXPECTED state on the free tier, not a fault:
  // the key resets daily and the items were never inserted, so the next run
  // simply picks them up. Say so loudly and exit 0. Failing red every three
  // hours for a condition that is understood and time-based trains you to ignore
  // the one red run that means something. The retrieval check is what should go
  // red if the library actually stops being able to answer.
  if (quotaHit) {
    console.error('\nEMBEDDING ALLOWANCE EXHAUSTED upstream — stopped early, nothing lost.');
    console.error('The provider rejected a request with 402/429. This key is shared with live chat,');
    console.error(`so continuing would spend the rest of the day's allowance on retries that cannot succeed.`);
    console.error(`Per-run budget is ${MAX_EMBED_REQUESTS_PER_RUN} (env INGEST_EMBED_BUDGET). Deferred items are re-collected next run.`);
    return;
  }

  if (failed > 0 && added === 0) {
    console.error('Every attempted item failed and nothing was added — failing the run so it is visible.');
    process.exit(1);
  }
}

// Run main() only when this file is executed directly, so a test can import the
// pure helpers above (makeBatches, embedTextOf) without kicking off a live
// ingestion — which would exit(1) on the missing secrets before asserting a thing.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(err => { console.error(err); process.exit(1); });
}
