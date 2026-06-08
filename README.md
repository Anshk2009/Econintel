# EconIntel — Economics AI Chat

Static frontend for EconIntel: a polished, animated economics-analysis interface that talks to an EdgeOne backend.

## Files

- `index.html` — Landing page (animated gradient background, crisis analogues, pricing, sources)
- `chat.html` — Chat terminal (flat dark background, account modal, history)
- `config.js` — Points the frontend at the backend API (EdgeOne)

No build step. Pure HTML/CSS/JS.

## Deploy to Vercel (static)

1. Import this repo at https://vercel.com/new
2. **Framework Preset: `Other`** (it's a static site — there is no build)
3. Leave Build Command and Output Directory **empty**
4. Deploy

Vercel serves `index.html` at `/` and `chat.html` at `/chat.html`.

## Backend

`config.js` targets the EdgeOne backend (`econintel.edgeone.app`) for auth, chat, and history.
For auth/chat to work from the Vercel domain, that domain must be included in the
backend's `ALLOWED_ORIGIN` environment variable (CORS).

## License

Proprietary — EconIntel Inc. 2026
