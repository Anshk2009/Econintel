# EconIntel — RAG knowledge base ("the library")

This folder is the **source library** for EconIntel's RAG (retrieval) feature.
Nothing in here gets uploaded to EdgeOne — it's local/offline tooling. Its only
job is to fill the Supabase `documents` table with real source material that the
chat can search and cite.

## How it actually works (read this first)

The AI does **not** read these files directly. The flow is:

```
text files in /documents      RSS feeds in feeds.json
        |                              |
        v                              v
   ingest-files.mjs              ingest-live.mjs        <-- you run these
        |                              |
        +--------------+---------------+
                       v
            embed each chunk (numbers)
                       v
        store in Supabase `documents` table
                       v
        chat.js searches it at question time   <-- the AI "reads" it here
```

So: **put real text in → run an ingester → it lands in Supabase → the chat can use it.**

## What's in here

| File | What it is |
|------|------------|
| `schema.sql` | The Supabase setup — run it once in the SQL editor to create the `documents` table + `match_documents` function. |
| `sources-catalog.md` | The master human-readable list of every source/outlet we trust, with URLs + RSS feeds. Reference only. |
| `feeds.json` | The machine-readable list of RSS feeds the LIVE ingester polls. |
| `ingest-live.mjs` | Fetches the latest news from every feed in `feeds.json` and stores it. Run this on a schedule for "live" world news. |
| `documents/` | Where you put REAL article/report/case-study text files (one document per file). |
| `documents/_TEMPLATE.md` | The exact format a document file must follow. Copy it. |
| `documents/case-studies-to-seed.md` | The list of canonical historical case studies to seed once, with real source URLs to pull each from. |

## One-time database setup (run in Supabase SQL editor)

Open `schema.sql` (in this folder) and run it once in the Supabase SQL editor.
It creates the `documents` table — with a `vector(2048)` embedding column to
match the NVIDIA embedding model — the `match_documents` search function, and
the dedupe index on `source_url`.

Note: embeddings are **2048 dimensions**. pgvector's fast HNSW index only
supports up to 2000 dims, so search is exact (no vector index) for now — fine
while the library is small. To scale later, switch the column to `halfvec(2048)`
and add an HNSW index (one command — ask when you need it).

## How to add your OWN documents (manual)

1. Copy `documents/_TEMPLATE.md` to a new file, e.g. `documents/2008-gfc.md`.
2. Paste the REAL text (an article, a report excerpt, a case study) into it.
3. Fill the top fields: `source_name`, `source_url`, `published_at`.
4. Run the file ingester (the `ingest-files.mjs` from the main plan, pointed at
   `./documents`). It chunks + embeds + stores everything.

## How to feed it LIVE world news (automatic)

`ingest-live.mjs` reads `feeds.json`, pulls the newest items from each feed,
skips anything already stored, embeds the rest, and saves them. Run it on a
schedule (every few hours). Three free ways to schedule it:

- **Windows Task Scheduler** (simplest on your machine): run `node ingest-live.mjs`
  every 3–6 hours while your PC is on.
- **GitHub Actions cron** (best — runs in the cloud, free): a workflow that runs
  the script on a schedule with your keys stored as repo secrets.
- **EdgeOne scheduled function** (if your plan supports cron triggers).

## Important — honesty about content

The text you store becomes what the AI cites as "primary sources." So:

- **Only store REAL material.** The live feeds pull real news automatically.
  For case studies and manual docs, paste real article/report text — never
  made-up analysis, or the chat will cite sources that don't exist and break
  your "primary-source-only" promise.
- RSS gives you the **headline + summary + link** (not always the full article).
  That's enough for the chat to point at and cite the real source. Pull full
  article text only if you need deeper retrieval.

## Cost & housekeeping

- Embeddings are **free** — nvidia/llama-nemotron-embed-vl-1b-v2:free via
  OpenRouter, using the same key as chat — so live news costs ₹0 to embed.
- News piles up. To stay inside Supabase's free tier, delete old news
  periodically, e.g. in the SQL editor:
  ```sql
  delete from documents
  where category = 'news' and published_at < now() - interval '90 days';
  ```
