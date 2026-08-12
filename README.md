# EconIntel — Economics AI Chat

Static frontend for EconIntel: a polished, animated economics-analysis interface that talks to an EdgeOne backend.

## Files

- `index.html` — Landing page (animated gradient background, crisis analogues, pricing, sources)
- `chat.html` — Chat terminal (flat dark background, account modal, history)
- `blogs.html` / `newsletter.html` — "Coming soon" placeholders (`noindex` until they carry real content)
- `404.html` — Custom not-found page (EdgeOne serves it automatically)
- `config.js` — Points the frontend at the backend API (EdgeOne)
- `favicon.svg`, `robots.txt`, `sitemap.xml` — Site metadata
- `functions/` — EdgeOne Edge Functions (auth, chat, chat history, shared middleware)
- `rag/` — Local-only tooling that fills the Supabase `documents` table (never deployed)
- `migrations/` — SQL run by hand in the Supabase SQL editor

No build step. Pure HTML/CSS/JS.

## Database setup

Run `schema_supabase.sql` in the Supabase SQL editor to create the app tables
(`users`, `chat_history`, `kv_store`, …). Without it, signup fails with a 500
because the `users` table doesn't exist. The RAG `documents` table is separate —
see `rag/schema.sql`. Numbered files in `migrations/` are applied after that, in
order.

## Deploy (EdgeOne Pages)

No build step. Upload the files to the EdgeOne Pages dashboard (or connect this
repo). EdgeOne serves `index.html` at `/` and `chat.html` at `/chat.html`, and
runs everything in `functions/` as Edge Functions.

## Backend

`config.js` targets the EdgeOne backend (`econintel.edgeone.app`) for auth, chat, and history.
For auth/chat to work from the deployed domain, that domain must be included in the
backend's `ALLOWED_ORIGIN` environment variable (CORS).

## License

Proprietary — EconIntel Inc. 2026
