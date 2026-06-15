# EconIntel — Structured Economic Intelligence AI

**Economics reimagined through structured reasoning, not news feeds.**

EconIntel is a production-ready AI chat application that delivers sharp, sourced economic analysis backed by historical case studies and real-time data from authoritative sources worldwide.

---

## What is EconIntel?

EconIntel is an economics-focused AI assistant that:

- **Reasons structurally** — Maps current economic conditions to historical analogues and causal mechanisms
- **Sources everything** — Every claim is hyperlinked to BBC, IMF, World Bank, OECD, central banks, and financial data
- **Analyzes deeply** — Provides bullet-point analysis: core take → evidence → historical parallel → what to watch
- **Works in real-time** — Integrates live economic signals and policy announcements

Unlike news aggregators, EconIntel doesn't report *what* happened. It explains *why* it matters and *what to watch next*.

---

## Key Features

🧠 **Structured Reasoning**
- Causal analysis, not headlines
- Historical precedent for every take
- Mechanism-based explanation

🔗 **Hyperlinked Intelligence**
- Every source is clickable
- Trusted data from 9+ authoritative sources
- Case studies with direct links

⚡ **Real-Time Economics**
- Central bank statements parsed instantly
- Market crises analyzed with historical parallels
- Forward guidance extracted from CEO calls

🔒 **Production Security**
- JWT authentication with token versioning
- Rate limiting (10-unlimited queries per month)
- User ownership validation (IDOR protection)
- PBKDF2 password hashing, CORS validation, CSP headers

📱 **Fully Responsive**
- Works on mobile, tablet, desktop
- Hamburger menu for small screens
- Touch-optimized interface

✨ **Beautiful UI**
- Real ShaderGradient animated backgrounds
- Smooth transitions and loading states
- Professional typography (Syne, DM Sans)

---

## Technology Stack

### Frontend
- **Next.js 16** — React framework with optimized performance
- **ShaderGradient** — Real-time animated shader backgrounds
- **Tailwind CSS** — Utility-first styling
- **TypeScript** — Type-safe development

### Backend
- **EdgeOne** — Cloudflare edge functions for low-latency API responses
- **Supabase PostgreSQL** — User data, chat history, API usage tracking
- **OpenRouter** — LLM API with model flexibility across providers
- **JWT + PBKDF2** — Stateless authentication with secure password hashing

### Deployment
- **EdgeOne Pages** — Static frontend + Edge Functions (auth, chat, history)
- **GitHub** — Source control with secrets protection

---

## How It Works

### User Flow
1. User lands on landing page with animated ShaderGradient background
2. Clicks "ENTER TERMINAL" → Chat interface
3. Asks economic question: *"What's happening with interest rates?"*
4. AI responds with:
   - **Core take** — One sharp bullet
   - **Evidence** — 2-3 bullets with mechanism
   - **Historical parallel** — With hyperlinked case study
   - **What's next** — 1-2 bullets on watch items
5. User clicks sources → Opens BBC, IMF, etc. in new tab

### Architecture
```
User Browser
    ↓
Static Frontend (landing + chat)
    ↓
EdgeOne Edge Function (/functions/chat)
    ↓
OpenRouter API
```

---

## Plans & Pricing

| Plan | Monthly | Annual | Queries | Features |
|------|---------|--------|---------|----------|
| **Free** | Free | Free | 10/mo | Crisis library, 3 sources |
| **Pro** | $15 | $180 | Unlimited | All sources, real-time signals |
| **Enterprise** | $30 | $360 | Unlimited | Custom sources, API access, SLA |

---

## Security & Privacy

✅ **Authentication**
- JWT tokens with 7-day expiry
- Token versioning for instant session invalidation
- Password reset via email token

✅ **Authorization**
- User ownership validation on all data
- Rate limiting per tier (prevents abuse)
- CSRF protection on state-modifying operations

✅ **Data Protection**
- PBKDF2-SHA256 password hashing (100,000 iterations)
- All credentials in environment variables (never in git)
- HTTPS-only enforcement

✅ **Privacy**
- No third-party tracking
- User data stored in Supabase (US-east or EU-west)
- Soft deletes for GDPR compliance (Phase 10)

---

## Deployment

### Deploy to EdgeOne Pages

1. Upload the files to the EdgeOne Pages dashboard (or connect this GitHub repo).
2. Set environment variables in the EdgeOne dashboard:
   ```
   OPENROUTER_API_KEY=***
   JWT_SECRET=***
   SUPABASE_URL=***
   SUPABASE_ANON_KEY=***
   ALLOWED_ORIGIN=https://your-domain.edgeone.app
   ```
3. No build step — EdgeOne serves the static files and runs `functions/` as Edge Functions.

---

## Local Development

```bash
# Install dependencies
npm install

# Create .env.local (copy from .env.example)
cp .env.example .env.local
# Fill in your EdgeOne URL, OpenRouter key, JWT secret

# Run dev server
npm run dev

# Open browser to http://localhost:3000
```

---

## Project Structure

```
econintel/
├── app/
│   ├── page.tsx              # Landing page with ShaderGradient
│   ├── chat/page.tsx         # Chat interface
│   ├── api/chat/route.ts     # API proxy to EdgeOne
│   ├── layout.tsx            # Root layout
│   └── globals.css           # Global styles + Tailwind
├── functions/                # EdgeOne backend
│   ├── auth.js              # Authentication (signup, login, reset)
│   ├── chat.js              # Chat endpoint (proxies to OpenRouter)
│   ├── chat-history.js      # Chat history retrieval
│   └── middleware.js        # Shared auth utilities
├── package.json             # Dependencies
├── next.config.js
├── tsconfig.json
├── tailwind.config.js
├── .env.example             # Environment template (safe to commit)
└── .gitignore               # Blocks .env.local, node_modules, etc.
```

---

## Team

👨‍💻 **Built by:** Ansh Kashyap  
⚙️ **Powered by:** OpenRouter, Cloudflare EdgeOne, Supabase  
🎨 **UI/UX:** ShaderGradient, Tailwind CSS  

---

## License

Proprietary — EconIntel Inc. 2026

---

## Getting Started

1. **Clone or fork this repo**
2. **Copy `.env.example` to `.env.local` and fill in your values**
3. **Run `npm install && npm run dev`**
4. **Open http://localhost:3000**
5. **Click "ENTER TERMINAL" to chat**

---

## Status

✅ **Production Ready**
- Phases 1-9 (MVP security hardening) complete
- Real ShaderGradient backgrounds working
- JWT auth + rate limiting implemented
- Chat, auth, and history endpoints live

🚀 **Deployed on EdgeOne Pages**
- Static frontend + Edge Functions
- OpenRouter integration active

📋 **Roadmap**
- Phase 10: Soft deletes & anonymization
- Phase 11: Audit logging
- Phase 12: TOTP 2FA
- Phase 13: Field-level encryption
- Phase 14: GDPR compliance tools
- Phase 15: E2E testing & CI/CD

---

## Support & Contributing

For issues, suggestions, or contributions:
1. Create a GitHub issue
2. Include: description, steps to reproduce, expected vs. actual
3. Attach relevant logs or screenshots

---

**Ready to reason through economics? Start chatting.** 🚀
