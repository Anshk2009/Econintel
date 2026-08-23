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

No build step. EdgeOne is linked to this repo (`main`) and auto-deploys on push.
It serves `index.html` at `/` and `chat.html` at `/chat.html`, and runs
everything in `functions/` as Edge Functions.

**This repo is the only deploy source.** There used to be a second local copy at
`EconIntel/deployment-econintel/` that had to be hand-synced. It never was the
deploy source — proven on 2026-08-23: it carries a root `auth.js` and a
`node_modules/` tree, and EdgeOne serves every non-dot root file, yet both 404
live. It is now marked `ARCHIVED.md` and can be deleted. Do not mirror into it.

## Security headers — the one thing the repo cannot fix

**Status: OPEN. This needs three clicks in the EdgeOne dashboard.**

Measured with `curl -D-` on 2026-08-22: the live site returns **no** security
headers on any HTML response. `functions/_middleware.js` existed to add them and
never ran — EdgeOne serves static HTML straight from CDN cache without invoking
Pages middleware (`EO-Cache-Status: Cache Hit`), so the file was deleted rather
than left standing as assurance it wasn't providing. Function responses do carry
their headers, because `jsonResponse()` in `functions/middleware.js` sets them
per-response; that is what made this look solved.

What the repo now does on its own:

- a real `Content-Security-Policy` `<meta>` on every page — `default-src 'self'`
  plus a per-page host allowlist, replacing the old `object-src`-only baseline
- `<meta name="referrer" content="strict-origin-when-cross-origin">`
- a framebuster on `index.html` and `chat.html`, because `frame-ancestors` and
  `X-Frame-Options` are header-only and those two pages carry credentials

### What about a config file?

EdgeOne Pages *does* support a routes config with a `headers` field — a
`version: 3` schema (`{"src": "^/.*$", "headers": {…}}`, `handle: "filesystem"`),
which is the Vercel build-output spec. Checked 2026-08-23, and it does not help
here: it is a **build-output** format, written into `.edgeone/` by a framework's
builder. This project has no build step, and the docs do not say where the file
goes for a plain static deploy. A malformed routes config can 404 the whole site,
so it is not worth guessing at on a live site for a header you can set with three
clicks. Revisit if EdgeOne documents a static-site path.

What needs the dashboard — EdgeOne Pages → your project → **Rules /
Response headers**, applied to `/*`:

```
Strict-Transport-Security: max-age=63072000; includeSubDomains
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Content-Security-Policy: frame-ancestors 'none'
```

Verify it landed — the daily smoke test prints a `note` line until it does:

```bash
curl -sS -D - -o /dev/null https://econintel.edgeone.app/chat.html | grep -i 'frame\|strict-transport\|nosniff'
```

## Monitoring

- **Heartbeat** (`.github/workflows/heartbeat.yml`) — runs `node
  .scripts/smoke.mjs --cheap` every 30 minutes. Costs nothing: cheap mode drops
  the one check that sends a real chat message. GitHub emails you when it fails.
- **Daily smoke** (`.github/workflows/smoke.yml`) — the full suite, including a
  real guest chat message, once a day plus on function/page changes.
- **Retrieval quality** (`.github/workflows/check-retrieval.yml`) — weekly golden
  queries against the live library, 70% bar.

Two things GitHub Actions cannot do for you, both free, both a few minutes:

1. **UptimeRobot** (or similar) pointed at `https://econintel.edgeone.app/`.
   GitHub's cron is best-effort and it silently **disables scheduled workflows
   after 60 days of repo inactivity** — so over a quiet exam season the heartbeat
   stops and nothing announces that. An external monitor doesn't have that
   failure mode, and it can text you.
2. **Supabase backups.** Nothing in this repo backs up `users` or
   `chat_history`. Check what your Supabase plan retains and, if it retains
   nothing, take a manual dump before any migration that touches those tables.

## Backend

`config.js` targets the EdgeOne backend (`econintel.edgeone.app`) for auth, chat, and history.
For auth/chat to work from the deployed domain, that domain must be included in the
backend's `ALLOWED_ORIGIN` environment variable (CORS).

## License

Proprietary — EconIntel Inc. 2026
