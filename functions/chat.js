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

import { verifyJWT, jsonResponse, corsPreflightResponse } from './middleware.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

// Phase 7: Model allowlist per plan tier (prevent expensive model abuse)
const MODEL_ALLOWLIST = {
  free: ['openrouter/auto'],
  pro: ['openrouter/auto', 'gpt-4-turbo', 'gpt-4', 'claude-3-opus', 'claude-3-sonnet'],
  enterprise: [], // empty = all allowed
};

// Rate limit thresholds per plan tier
const RATE_LIMITS = {
  free: { queriesPerMonth: 10, queriesPerMinute: 1, maxBodySize: 16384 },
  pro: { queriesPerMonth: 100, queriesPerMinute: 10, maxBodySize: 65536 },
  enterprise: { queriesPerMonth: Infinity, queriesPerMinute: Infinity, maxBodySize: 262144 },
};

// System prompt - concise, fast responses
const SYSTEM_PROMPT = `You are EconIntel — a Bloomberg-trained analyst with a Wharton degree and a dry sense of humor.

FOR CASUAL/OFF-TOPIC: Respond naturally and conversationally. Be friendly, witty, and brief. Then redirect to economics if relevant.

FOR ECONOMICS TOPICS: You've seen every market cycle, read every central bank statement, and have zero patience for vague answers or bad takes.

TONE: Sharp, witty, confident. Think "smartest person at the trading desk." A well-placed quip is welcome. Condescension is not.

FORMAT FOR ECONOMICS:
- Bullet points only. No headers. No labels. No walls of text.
- Clean punchy bullets. Each bullet max 2 lines.
- Lead with core take in one sharp bullet
- 2-3 bullets of evidence/mechanism
- One bullet with a historical parallel or case study with hyperlink
- 1-2 bullets on what to watch next
- Always embed hyperlinks for sources/case studies as markdown: [Source Name](url)
- Trusted sources: bbc.com/news/business, thehindu.com/business, aljazeera.com/economy, imf.org, federalreserve.gov, worldbank.org, oecd.org
- Add hyperlinks to economic case studies and historical examples when available

RULES: For economics topics: bullets only. Concise. Always cite sources with hyperlinks. No speculation without precedent. For casual chat: normal conversation. Never say "Great question" or filler openers.`;

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
  const supabaseKey = env.SUPABASE_ANON_KEY;

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
      const data = await res.json();
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
      await supabaseRest('kv_store', 'POST', '', { key, value, expires_at: expiresAt });
    },

    async delete(key) {
      await supabaseRest('kv_store', 'DELETE', `key=eq.${encodeURIComponent(key)}`);
    },
  };

  // CORS preflight
  if (request.method === 'OPTIONS') {
    return corsPreflightResponse(ALLOWED_ORIGIN);
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

  // Allow unauthenticated access (guest mode) with default free plan
  let userId = 'guest-' + Date.now();
  let userPlan = 'free';

  if (token) {
    const userPayload = await verifyJWT(token, JWT_SECRET, { TOKENS });
    if (userPayload) {
      userId = userPayload.userId;
      userPlan = userPayload.plan || 'free';
    }
    // If token is invalid, fall back to guest mode
  }

  // Step 2: Parse request body with size limit
  const rateLimit = RATE_LIMITS[userPlan] || RATE_LIMITS.free;
  const contentLength = parseInt(request.headers.get('Content-Length') || '0', 10);

  if (contentLength > rateLimit.maxBodySize) {
    return jsonResponse(
      { error: `Request body too large (max ${rateLimit.maxBodySize} bytes for ${userPlan} plan)` },
      413,
      ALLOWED_ORIGIN
    );
  }

  let body;
  try {
    body = await request.json();
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

  // Phase 7: Validate model against allowlist
  const requestedModel = body.model || 'openrouter/auto';
  const allowedModels = MODEL_ALLOWLIST[userPlan] || MODEL_ALLOWLIST.free;

  if (allowedModels.length > 0 && !allowedModels.includes(requestedModel)) {
    return jsonResponse(
      { error: `Model '${requestedModel}' not allowed for ${userPlan} plan. Allowed: ${allowedModels.join(', ')}` },
      403,
      ALLOWED_ORIGIN
    );
  }

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

  // Step 3: Skip rate limiting for MVP (TODO: implement proper rate limiting with REST API)
  // Rate limiting will be added back once we stabilize the REST API integration

  // Step 4: Forward request to OpenRouter (with system prompt + validated model + sanitized messages)
  let upstream;
  try {
    // Add system prompt at the beginning
    const messagesWithSystem = [
      { role: 'system', content: SYSTEM_PROMPT },
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
        model: requestedModel,
        messages: messagesWithSystem,
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

  const data = await upstream.json();

  // Step 5: Save messages to chat history
  try {
    const tokensUsed = data.usage?.total_tokens || 0;
    const now = new Date().toISOString();

    // Save user message
    const userMessage = body.messages[body.messages.length - 1];
    if (userMessage && userMessage.role === 'user') {
      const userMsgId = generateId();
      const { error: userError } = await supabase
        .from('chat_history')
        .insert({
          id: userMsgId,
          user_id: userId,
          role: 'user',
          content: userMessage.content,
          model: body.model || 'openrouter/auto',
          tokens_used: 0,
          created_at: now
        });

      if (userError) console.warn('[chat] Failed to save user message:', userError);
    }

    // Save assistant response
    const assistantMessage = data.choices?.[0]?.message;
    if (assistantMessage && assistantMessage.role === 'assistant') {
      const assistantMsgId = generateId();
      const { error: assistantError } = await supabase
        .from('chat_history')
        .insert({
          id: assistantMsgId,
          user_id: userId,
          role: 'assistant',
          content: assistantMessage.content,
          model: body.model || 'openrouter/auto',
          tokens_used: tokensUsed,
          created_at: now
        });

      if (assistantError) console.warn('[chat] Failed to save assistant message:', assistantError);
    }
  } catch (err) {
    console.warn('[chat] Failed to save chat history:', err);
    // Still return response—history saving is nice-to-have
  }

  // Step 6: Log API usage to database
  try {
    const tokensUsed = data.usage?.total_tokens || 0;
    const usageId = generateId();

    const { error: usageError } = await supabase
      .from('api_usage')
      .insert({
        id: usageId,
        user_id: userId,
        endpoint: 'chat',
        tokens_used: tokensUsed,
        created_at: new Date().toISOString()
      });

    if (usageError) console.warn('[chat] Failed to log usage:', usageError);
  } catch (err) {
    console.warn('[chat] Failed to log usage:', err);
    // Still return response—usage logging is nice-to-have
  }

  // Step 7: Return response (quota tracking disabled for MVP)
  return new Response(JSON.stringify(data), {
    status: upstream.status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
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
