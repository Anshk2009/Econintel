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
- `.rag/` — Local-only tooling that fills the Supabase `documents` table
- `.migrations/` — SQL run by hand in the Supabase SQL editor
- `.scripts/` — Dev tooling: live smoke test and link checker

No build step. Pure HTML/CSS/JS.

### Why some folders start with a dot

EdgeOne Pages serves **everything in the repo root** as a static file. It does
NOT serve anything whose path starts with a dot. Before this was understood,
`schema_supabase.sql`, every file in `migrations/`, and the whole RAG pipeline
(including `feeds.json`, whose own comment claims it is "never shown anywhere on
the website") were all publicly fetchable at e.g.
`https://econintel.edgeone.app/schema_supabase.sql` — handing out the complete
database schema to anyone who guessed the path.

The dot prefix is what keeps them private. **Do not rename `.rag/`,
`.migrations/`, `.scripts/` or `.package.json` back** without another way to
exclude them, or they go public again silently. `functions/` is the exception:
EdgeOne treats it as edge-function source and never serves it as static files.

One consequence worth knowing: with no `package.json` in the repo root, Node
treats a `.js` file as CommonJS, so `node --check functions/*.js` fails on
Node 20 (those files use ESM `import`). CI works around it by copying each file
to `.mjs` before checking — see `.github/workflows/ci.yml`. Local Node 22.7+
auto-detects ESM and passes either way, which is exactly why this is easy to
break without noticing.

To verify after any deploy:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://econintel.edgeone.app/.migrations/schema_supabase.sql   # expect 404
```

## Database setup

Run `.migrations/schema_supabase.sql` in the Supabase SQL editor to create the app tables
(`users`, `chat_history`, `kv_store`, …). Without it, signup fails with a 500
because the `users` table doesn't exist. The RAG `documents` table is separate —
see `.rag/schema.sql`. Numbered files in `.migrations/` are applied after that, in
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
