// EconIntel — Chat Edge Function (Secured)
// Proxies requests to OpenRouter, with authentication and rate limiting.
// Deploy this file to: functions/chat.js in your EdgeOne project.
//
// SECURITY: API key and JWT secret are read from environment variables.
// Set these in EdgeOne dashboard under Environment Variables:
//   OPENROUTER_API_KEY = your-openrouter-api-key
//   JWT_SECRET = your-jwt-secret (>32 bytes)
//   ALLOWED_ORIGIN = https://yourdomain.com
//
// Requires:
//   - Supabase PostgreSQL database for chat history and API usage
//   - Functions: middleware.js with crypto utilities

import { verifyJWT, jsonResponse, corsPreflightResponse, hashIP } from './middleware.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

// Chat model, pinned server-side so users can't request a pricier one.
// gpt-oss-120b is free on OpenRouter and uses your EXISTING OPENROUTER_API_KEY
// (no new key needed). To upgrade later, drop ":free" for the paid endpoint,
// which has higher rate limits.
const MODEL = 'openai/gpt-oss-120b:free';

// Per-IP daily message limits enforced server-side.
// Guests use a separate 15-msg/day bucket (GUEST_LIMIT below).
// Authenticated users get a larger daily bucket keyed by their IP hash.
const RATE_LIMITS = {
  free:       { dailyPerIP: 50,   queriesPerMinute: 1,        maxBodySize: 16384  },
  pro:        { dailyPerIP: 250,  queriesPerMinute: 10,       maxBodySize: 65536  },
  enterprise: { dailyPerIP: 1000, queriesPerMinute: Infinity, maxBodySize: 262144 },
};

// System prompt - concise, fast responses.
// Voice/format reworked per founder's brief (sharper "trading desk" persona,
// strict bullets). The SOURCES POLICY is deliberately the SAFE one — no
// "always cite", no hardcoded domain allowlist — because telling the model to
// always cite with no retrieved source makes gpt-oss-120b fabricate plausible
// fake links/figures (the documented "empty library = confident fabrication"
// bug). Sources are on-demand only and come ONLY from retrieval-injected SOURCES.
const SYSTEM_PROMPT = `You are EconIntel — a Bloomberg-trained analyst with a Wharton degree and a dry sense of humour. You've seen every market cycle, read every central-bank statement, and have zero patience for vague answers or bad takes.

PERSONA DEPTH: You think in frameworks, not opinions. You connect current events to historical precedent instinctively. You are confident but not reckless — you distinguish between what the data shows, what history suggests, and what is genuinely uncertain. You never bluff.

SCOPE: Economics, geopolitics, central banking, markets, trade, currencies, fiscal/monetary policy, sanctions, and anything closely connected. If someone asks something genuinely off-topic, one dry witty line maximum — then find the economics angle if one exists. If none exists, invite them back. Never be cold.

GREETINGS & SMALL TALK: Always welcome. Reply warmly in one or two lines and invite them to ask about the economy or markets. The scope rule never applies to greetings. Never decline or redirect a casual hello.

DEPTH CALIBRATION:
- Simple question → tight, punchy answer. 3–4 bullets max.
- Complex / multi-part question → go deeper, but never exceed 5 bullets. No padding.
- Follow-up question → assume context from prior exchange. Don't re-explain what was already established.

TONE: Sharp, witty, confident. Less academic paper, more senior analyst who also reads history books and has strong opinions about central bankers. A well-placed quip is welcome. Condescension is not. Never open with "Great question", "Certainly", "Of course" or any filler phrase.

FORMAT: Bullets only. No headers, no labels, no walls of text. Each bullet maximum 2 lines — claim, evidence, implication in one clean flow.

STRUCTURE (invisible — never label these):
- One sharp bullet with the core take
- 2–3 bullets of evidence, mechanism, or second-order effects
- One bullet with a historical parallel (only where genuinely relevant — skip if forced)
- 1–2 bullets on what to watch next or what would change the thesis

UNCERTAINTY HANDLING: When something is genuinely uncertain or contested, say so in one clean bullet — "The honest answer is X is unclear because Y." Never speculate beyond what a senior analyst would confidently state on record. Never fabricate a number, statistic, or precedent.

SOURCES POLICY: Say nothing about sources unprompted — no citations, no links, no disclaimers. Only when the user explicitly asks ("source?", "where's that from?", "any link?") do you address sources. If provided sources back the claim, cite as [Source Name](url). If not, say plainly you don't have a specific source for it — once, briefly, only in direct reply. Never invent a source.

HARD RULES:
- Bullets only. Always.
- Never fabricate sources, statistics, or historical events.
- Never tack disclaimers onto answers unless directly asked.
- Never repeat the user's question back to them.
- Never end with "Let me know if you have questions" or similar.`;

// Content filter
const BLOCKED = [/\b(bomb|weapon|kill|murder|hack|exploit|drug|porn|sex|nude|naked|terrorist|suicide|self.harm)\b/i];
function isBlocked(text) {
  return BLOCKED.some(pattern => pattern.test(text));
}

export async function onRequest(context) {
  const { request, env } = context;

  // Read secrets from environment variables (fail loud if missing)
  if (!env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY not configured');
  if (!env.JWT_SECRET) throw new Error('JWT_SECRET not configured');
  if (!env.ALLOWED_ORIGIN) throw new Error('ALLOWED_ORIGIN not configured');
  if (!env.SUPABASE_URL) throw new Error('SUPABASE_URL not configured');
  if (!env.SUPABASE_ANON_KEY) throw new Error('SUPABASE_ANON_KEY not configured');

  const OPENROUTER_API_KEY = env.OPENROUTER_API_KEY;
  const JWT_SECRET = env.JWT_SECRET;
  const ALLOWED_ORIGIN = env.ALLOWED_ORIGIN;

  // Supabase REST API helper (no npm packages)
  const supabaseUrl = env.SUPABASE_URL;
  const supabaseKey = env.SUPABASE_ANON_KEY; // service_role key rejected by EdgeOne — anon key only

  async function supabaseRest(table, method = 'GET', filters = '', body = null) {
    let url = `${supabaseUrl}/rest/v1/${table}`;
    if (filters) url += `?${filters}`;

    const options = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${supabaseKey}`,
        'apikey': supabaseKey,
      },
    };

    if (body) options.body = JSON.stringify(body);

    try {
      const res = await fetch(url, options);
      if (!res.ok) {
        console.warn(`[supabase] ${method} ${table} failed:`, res.status);
        return { data: null, error: `HTTP ${res.status}` };
      }
      const _t = await res.text(); const data = _t ? JSON.parse(_t) : null;
      return { data, error: null };
    } catch (err) {
      console.warn(`[supabase] ${method} ${table} error:`, err);
      return { data: null, error: err.message };
    }
  }

  // KV store helper using REST API
  const TOKENS = {
    async get(key) {
      const { data } = await supabaseRest('kv_store', 'GET', `key=eq.${encodeURIComponent(key)}&expires_at=gt.${new Date().toISOString()}`);
      return data?.[0]?.value || null;
    },

    async put(key, value, opts) {
      const ttl = opts?.expirationTtl || 3600;
      const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
      // Upsert: kv_store.key is PRIMARY KEY, so Prefer: resolution=merge-duplicates
      // tells PostgREST to UPDATE on conflict instead of returning 409.
      // Plain POST (INSERT) would fail silently on duplicate keys, freezing counters at 1.
      await fetch(`${supabaseUrl}/rest/v1/kv_store`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${supabaseKey}`,
          'apikey': supabaseKey,
          'Prefer': 'resolution=merge-duplicates',
        },
        body: JSON.stringify({ key, value, expires_at: expiresAt }),
      });
    },

    async delete(key) {
      await supabaseRest('kv_store', 'DELETE', `key=eq.${encodeURIComponent(key)}`);
    },
  };

  // ---------------------------------------------------------------------------
  // RAG retrieval: turn the question into an embedding, then fetch the 3 most
  // relevant source chunks from Supabase so the model can answer from real,
  // citable material. FAILS OPEN — if anything here errors (key missing,
  // Supabase down, empty library), it returns '' and the chat just answers
  // normally instead of breaking.
  //
  // Embeddings use nvidia/llama-nemotron-embed-vl-1b-v2:free via OpenRouter
  // (2048 dims) — this MUST match the ingester (rag/ingest-live.mjs) and the
  // vector(2048) column (rag/schema.sql). Uses a SEPARATE OpenRouter key,
  // OPENROUTER_EMBED_KEY (set in EdgeOne env vars), so chat and embeddings have
  // independent keys/quota. Optional — if it's missing, retrieval just skips.
  // ---------------------------------------------------------------------------
  async function retrieveContext(query) {
    // 1. Embed the question (text -> a list of 2048 numbers) via OpenRouter.
    let queryEmbedding;
    try {
      const r = await fetch('https://openrouter.ai/api/v1/embeddings', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.OPENROUTER_EMBED_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: 'nvidia/llama-nemotron-embed-vl-1b-v2:free', input: query }),
      });
      if (!r.ok) return '';
      queryEmbedding = (await r.json()).data[0].embedding;
    } catch { return ''; }

    // 2. Ask Supabase (the match_documents function) for the 3 closest chunks.
    let chunks;
    try {
      const r = await fetch(`${supabaseUrl}/rest/v1/rpc/match_documents`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${supabaseKey}`,
          'apikey': supabaseKey,
        },
        body: JSON.stringify({ query_embedding: queryEmbedding, match_count: 3 }),
      });
      if (!r.ok) return '';
      chunks = await r.json();
    } catch { return ''; }

    // 3. Build a text block, keeping each chunk's name + real URL so the model
    //    can cite real primary sources.
    if (!Array.isArray(chunks) || chunks.length === 0) return '';
    return chunks
      .map((c, i) => `[${i + 1}] ${c.source_name} — ${c.source_url}\n${c.content}`)
      .join('\n\n');
  }

  // CORS preflight
  if (request.method === 'OPTIONS') {
    return corsPreflightResponse(ALLOWED_ORIGIN);
  }

  // Enforce Origin: if present and wrong, reject. Absent = allowed (same-origin / curl).
  const chatOrigin = request.headers.get('Origin');
  if (chatOrigin && !ALLOWED_ORIGIN.split(',').map(o => o.trim()).includes(chatOrigin)) {
    return jsonResponse({ error: 'Forbidden' }, 403, ALLOWED_ORIGIN);
  }

  // Only allow POST
  if (request.method !== 'POST') {
    return jsonResponse(
      { error: 'Method not allowed' },
      405,
      ALLOWED_ORIGIN
    );
  }

  // Step 1: Authenticate user (optional - JWT from Authorization header or access_token cookie)
  let token = getBearerToken(request);

  // Fall back to access_token cookie if no Authorization header
  if (!token) {
    const cookies = parseCookies(request);
    token = cookies.access_token;
  }

  // Guest quota: 15 messages per IP per day, then require sign-up
  const GUEST_LIMIT = 15;
  let userId, userPlan;

  if (!token) {
    // Unauthenticated — check IP-based guest quota
    const clientIP = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown';
    const ipHash = await hashIP(clientIP);
    const guestKey = `guest:quota:${ipHash}`;
    const used = parseInt(await TOKENS.get(guestKey) || '0', 10);

    if (used >= GUEST_LIMIT) {
      return jsonResponse({
        error: `You've used all ${GUEST_LIMIT} free messages. Sign up for 100 free queries/month — no credit card needed.`,
        code: 'GUEST_QUOTA_EXCEEDED'
      }, 401, ALLOWED_ORIGIN);
    }

    // Increment counter (resets after 24 hours)
    await TOKENS.put(guestKey, String(used + 1), { expirationTtl: 86400 });
    userId = `guest:${ipHash.slice(0, 12)}`;
    userPlan = 'free';
  } else {
    // Authenticated — verify JWT (includes token_version DB check)
    const userPayload = await verifyJWT(token, JWT_SECRET, {
      TOKENS,
      dbCheck: async (uid, tv) => {
        const { data } = await supabaseRest('users', 'GET', `id=eq.${encodeURIComponent(uid)}&select=token_version`);
        return data?.[0]?.token_version === tv;
      },
    });
    if (!userPayload) {
      return jsonResponse({ error: 'Invalid or expired session. Please sign in again.' }, 401, ALLOWED_ORIGIN);
    }
    userId = userPayload.userId;
    userPlan = userPayload.plan || 'free';
  }

  // IP-based daily rate limit for authenticated users.
  // Guests use the separate GUEST_LIMIT bucket above.
  // Key is keyed by IP hash so shared-IP scenarios degrade gracefully per network.
  if (token) {
    const authClientIP = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown';
    const authIPHash = await hashIP(authClientIP);
    const rlKey = `chat:rl:auth:ip:${authIPHash}`;
    const dailyLimit = (RATE_LIMITS[userPlan] || RATE_LIMITS.free).dailyPerIP;
    const used = parseInt(await TOKENS.get(rlKey) || '0', 10);

    if (used >= dailyLimit) {
      return jsonResponse({
        error: `Daily limit reached (${dailyLimit} messages/day on the ${userPlan} plan). Resets in 24 hours.`,
        code: 'DAILY_LIMIT_EXCEEDED',
      }, 429, ALLOWED_ORIGIN);
    }

    // Increment the daily counter (TTL 24h, upsert so it resets correctly)
    await TOKENS.put(rlKey, String(used + 1), { expirationTtl: 86400 });
  }

  // Step 2: Parse request body with size limit
  const rateLimit = RATE_LIMITS[userPlan] || RATE_LIMITS.free;

  // Fix: read actual body bytes — never trust the Content-Length header (attacker-controlled)
  let rawBody;
  try {
    rawBody = await request.arrayBuffer();
  } catch {
    return jsonResponse({ error: 'Failed to read request body' }, 400, ALLOWED_ORIGIN);
  }

  if (rawBody.byteLength > rateLimit.maxBodySize) {
    return jsonResponse(
      { error: `Request body too large (max ${rateLimit.maxBodySize} bytes for ${userPlan} plan)` },
      413,
      ALLOWED_ORIGIN
    );
  }

  let body;
  try {
    body = JSON.parse(new TextDecoder().decode(rawBody));
  } catch {
    return jsonResponse(
      { error: 'Invalid JSON body' },
      400,
      ALLOWED_ORIGIN
    );
  }

  if (!body.messages || !Array.isArray(body.messages)) {
    return jsonResponse(
      { error: 'Missing messages array' },
      400,
      ALLOWED_ORIGIN
    );
  }

  // Model is pinned server-side (see MODEL near the top of this file), so the
  // user can no longer choose it — the old per-plan allowlist check that read
  // body.model is therefore unnecessary and has been removed.

  // Phase 7: Cap message count (prevent token inflation)
  if (body.messages.length > 30) {
    return jsonResponse(
      { error: 'Too many messages in request (max 30)' },
      400,
      ALLOWED_ORIGIN
    );
  }

  // Phase 7: Strip system role from messages (server-side system prompt only)
  const sanitizedMessages = body.messages.filter(msg => msg.role !== 'system');

  // Content filter: check the latest user message against the blocked-keyword list.
  // Uses the BLOCKED regex defined at module scope (isBlocked function above).
  // Only checks the most recent message — previous ones were already checked when sent.
  const latestUserMsg = sanitizedMessages.filter(m => m.role === 'user').pop();
  if (latestUserMsg && isBlocked(latestUserMsg.content)) {
    return jsonResponse({ error: 'Message contains prohibited content.' }, 400, ALLOWED_ORIGIN);
  }

  // Step 4: Forward request to OpenRouter (with system prompt + validated model + sanitized messages)
  let upstream;
  try {
    // RAG: fetch relevant sources for the latest question and prepend them to
    // the system prompt so the model answers from real, citable material.
    // retrieveContext fails open ('') if retrieval is unavailable, so the chat
    // still works even if the library/embeddings are down.
    let systemPrompt = SYSTEM_PROMPT;
    if (latestUserMsg) {
      const context = await retrieveContext(latestUserMsg.content);
      if (context) {
        systemPrompt +=
          `\n\nSOURCES (use these to ground your answer; do NOT mention or cite them unless the user explicitly asks for a source — then cite only from these as [Name](url), never invented):\n\n${context}`;
      }
    }

    // Add the (possibly source-augmented) system prompt at the beginning
    const messagesWithSystem = [
      { role: 'system', content: systemPrompt },
      ...sanitizedMessages
    ];

    upstream = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': ALLOWED_ORIGIN,
        'X-Title': 'EconIntel',
      },
      body: JSON.stringify({
        model: MODEL,
        messages: messagesWithSystem,
        max_tokens: 550,
        temperature: 0.5,
        top_p: 0.9,
        stream: true, // tokens arrive immediately instead of waiting for full response
      }),
    });
  } catch (err) {
    console.error('[chat] OpenRouter fetch failed:', err);
    return jsonResponse(
      { error: 'Upstream service unavailable' },
      502,
      ALLOWED_ORIGIN
    );
  }

  // If OpenRouter returned an error (4xx/5xx), its body is JSON not SSE —
  // read it and forward a structured error so the frontend can display it.
  if (!upstream.ok) {
    let errData;
    try { errData = await upstream.json(); } catch {}
    return jsonResponse(
      { error: errData?.error?.message || 'AI service error' },
      upstream.status >= 500 ? 502 : upstream.status,
      ALLOWED_ORIGIN
    );
  }

  // Headers sent back on every streaming response
  const sseHeaders = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };

  // Guests: pipe the SSE stream straight through — no history to save
  if (userId.startsWith('guest:')) {
    return new Response(upstream.body, { status: 200, headers: sseHeaders });
  }

  // Authenticated users: pipe SSE to client AND accumulate the full response
  // text for saving to chat_history once the stream ends.
  // TransformStream passes every raw chunk through unchanged (client sees all
  // SSE events) while also parsing each chunk to extract the assistant delta.
  // flush() runs after the last chunk — saves both messages to the DB.
  // flush() is best-effort: if the edge function is terminated early (rare)
  // the history entry may be dropped, which is acceptable.
  let fullContent = '';
  const sseDecoder = new TextDecoder();
  let sseBuf = ''; // incomplete line buffer across chunks

  const { readable, writable } = new TransformStream({
    transform(chunk, controller) {
      // Decode chunk and accumulate delta text for history saving
      sseBuf += sseDecoder.decode(chunk, { stream: true });
      const lines = sseBuf.split('\n');
      sseBuf = lines.pop(); // save incomplete last line
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') { sseBuf = ''; continue; }
        try {
          const delta = JSON.parse(payload)?.choices?.[0]?.delta?.content || '';
          fullContent += delta;
        } catch {}
      }
      controller.enqueue(chunk); // pass raw chunk to client unchanged
    },

    async flush() {
      // Stream finished — persist to chat_history (best-effort)
      try {
        const now = new Date().toISOString();
        const userMessage = body.messages[body.messages.length - 1];
        if (userMessage?.role === 'user') {
          await supabaseRest('chat_history', 'POST', '', {
            id: generateId(), user_id: userId, role: 'user',
            content: userMessage.content,
            model: MODEL,
            tokens_used: 0, created_at: now,
          });
        }
        if (fullContent) {
          await supabaseRest('chat_history', 'POST', '', {
            id: generateId(), user_id: userId, role: 'assistant',
            content: fullContent,
            model: MODEL,
            tokens_used: 0, created_at: now,
          });
        }
      } catch (err) {
        console.warn('[chat] Failed to save streamed history:', err);
      }
    },
  });

  upstream.body.pipeTo(writable);
  return new Response(readable, { status: 200, headers: sseHeaders });
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Extract Bearer token from Authorization header
 */
function getBearerToken(request) {
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) {
    return null;
  }
  return auth.slice(7); // Remove "Bearer " prefix
}

/**
 * Parse cookies from request header.
 */
function parseCookies(request) {
  const cookies = {};
  const cookieHeader = request.headers.get('Cookie');
  if (!cookieHeader) return cookies;

  cookieHeader.split(';').forEach(cookie => {
    const [key, value] = cookie.trim().split('=');
    if (key && value) {
      cookies[key] = decodeURIComponent(value);
    }
  });

  return cookies;
}

/**
 * Generate a random ID (used for usage logging)
 */
function generateId() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode.apply(null, bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
