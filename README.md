# EconIntel — Economics AI Chat

Static frontend for EconIntel: a polished, animated economics-analysis interface that talks to an EdgeOne backend.

## Files

- `index.html` — Landing page (animated gradient background, crisis analogues, pricing, sources)
- `chat.html` — Chat terminal (flat dark background, account modal, history)
- `config.js` — Points the frontend at the backend API (EdgeOne)

No build step. Pure HTML/CSS/JS.

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
