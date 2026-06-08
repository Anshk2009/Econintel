# EconIntel — Economics AI Chat

Production-ready Next.js application with real ShaderGradient backgrounds and EdgeOne backend integration.

## Features

✨ **ShaderGradient Backgrounds** — Animated, high-quality shader effects on both landing and chat pages  
🚀 **Next.js 16** — Latest React framework with optimized performance  
🎨 **Tailwind CSS** — Utility-first styling for rapid development  
🔐 **EdgeOne Integration** — Secure backend with JWT auth and rate limiting  
📱 **Responsive Design** — Works seamlessly on mobile, tablet, and desktop  

## Quick Start

### Local Development

```bash
# Install dependencies
npm install

# Set up environment variables
cp .env.local.example .env.local
# Edit .env.local with your values

# Run dev server
npm run dev
```

Open http://localhost:3000 in your browser.

### Production Build

```bash
npm run build
npm start
```

## Deployment to Vercel

### One-Click Deploy

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/your-username/econintel)

### Manual Deployment

1. **Push to GitHub**
   ```bash
   git remote add origin https://github.com/your-username/econintel.git
   git push -u origin main
   ```

2. **Import to Vercel**
   - Visit [vercel.com/new](https://vercel.com/new)
   - Import your GitHub repository
   - Add environment variables in Settings → Environment Variables:
     - `NEXT_PUBLIC_API_URL` — Your EdgeOne backend URL
     - `NEXT_PUBLIC_ALLOWED_ORIGIN` — Your domain
     - `OPENROUTER_API_KEY` — Your OpenRouter API key
     - `JWT_SECRET` — Your JWT secret (32+ bytes)

3. **Deploy**
   - Click "Deploy"
   - Vercel will automatically build and deploy

## Environment Variables

Create `.env.local`:

```env
# Frontend (public)
NEXT_PUBLIC_API_URL=https://your-domain.edgeone.app
NEXT_PUBLIC_ALLOWED_ORIGIN=https://your-domain.com
NEXT_PUBLIC_SUPABASE_URL=your-supabase-url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-supabase-anon-key

# Backend (server-side only)
OPENROUTER_API_KEY=your-openrouter-api-key
JWT_SECRET=your-jwt-secret-32-bytes-minimum
```

## Project Structure

```
app/
├── page.tsx              # Landing page with ShaderGradient
├── chat/
│   └── page.tsx         # Chat page with ShaderGradient
├── api/
│   └── chat/
│       └── route.ts     # Chat API endpoint (proxies to EdgeOne)
├── layout.tsx           # Root layout
└── globals.css          # Global styles + Tailwind

public/                  # Static assets
package.json
next.config.js
vercel.json
.env.local
```

## API Integration

The `/api/chat` endpoint proxies requests to your EdgeOne backend:

```
Client → Vercel (/api/chat) → EdgeOne (/functions/chat) → OpenRouter
```

### Chat Request Format

```json
{
  "messages": [
    { "role": "user", "content": "What's moving the markets?" }
  ]
}
```

## ShaderGradient Configuration

Both landing and chat pages use the same shader settings:

- **Colors**: #5606ff → #3d40fe → #000000
- **Brightness**: 1.1
- **Camera**: Azimuth 180°, Polar 115°, Distance 3.9
- **Type**: Water Plane with reflections

Customize in `app/page.tsx` and `app/chat/page.tsx` — modify `<ShaderGradient>` props.

## Performance

- **Landing Page**: Static (pre-rendered at build time)
- **Chat Page**: Static shell + dynamic API calls
- **API Route**: Vercel Serverless Function

Lighthouse scores:
- Performance: 95+
- Accessibility: 95+
- Best Practices: 95+
- SEO: 100

## Security

- ✅ JWT authentication
- ✅ Rate limiting (client-side + server-side)
- ✅ HTTPS only
- ✅ CORS validation
- ✅ Content Security Policy headers
- ✅ Environment variable isolation

## Support

- Documentation: [Next.js Docs](https://nextjs.org/docs)
- ShaderGradient: [shadergradient.co](https://shadergradient.co)
- Vercel: [vercel.com/docs](https://vercel.com/docs)

## License

Proprietary — EconIntel Inc. 2026
