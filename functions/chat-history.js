// EconIntel — Chat History Function
// Handles retrieving and managing user chat history.
// Deploy to: functions/chat-history.js in your EdgeOne project.

import { verifyJWT, jsonResponse, corsPreflightResponse } from './middleware.js';

// Hoisted to module scope so the top-level handlers (handleGetHistory,
// handleDeleteHistory) can use them — assigned at the top of onRequest.
let supabaseRest, TOKENS;

export async function onRequest(context) {
  const { request, env } = context;

  // Fail loud if config missing
  if (!env.JWT_SECRET) throw new Error('JWT_SECRET not configured');
  if (!env.ALLOWED_ORIGIN) throw new Error('ALLOWED_ORIGIN not configured');
  if (!env.SUPABASE_URL) throw new Error('SUPABASE_URL not configured');
  if (!env.SUPABASE_ANON_KEY) throw new Error('SUPABASE_ANON_KEY not configured');

  const JWT_SECRET = env.JWT_SECRET;
  const ALLOWED_ORIGIN = env.ALLOWED_ORIGIN;

  // Supabase REST API helper (no npm packages)
  const supabaseUrl = env.SUPABASE_URL;
  const supabaseKey = env.SUPABASE_ANON_KEY; // service_role key rejected by EdgeOne — anon key only

  supabaseRest = async function supabaseRest(table, method = 'GET', filters = '', body = null) {
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
  };

  // KV store helper using REST API
  TOKENS = {
    async get(key) {
      const { data } = await supabaseRest('kv_store', 'GET', `key=eq.${encodeURIComponent(key)}&expires_at=gt.${new Date().toISOString()}`);
      return data?.[0]?.value || null;
    },

    async put(key, value, opts) {
      const ttl = opts?.expirationTtl || 3600;
      const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
      // Upsert: kv_store.key is PRIMARY KEY, so Prefer: resolution=merge-duplicates
      // tells PostgREST to UPDATE on conflict instead of returning 409.
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

  // CORS preflight
  if (request.method === 'OPTIONS') {
    return corsPreflightResponse(ALLOWED_ORIGIN);
  }

  // Enforce Origin: if present and wrong, reject. Absent = allowed (same-origin / curl).
  const histOrigin = request.headers.get('Origin');
  if (histOrigin && !ALLOWED_ORIGIN.split(',').map(o => o.trim()).includes(histOrigin)) {
    return jsonResponse({ error: 'Forbidden' }, 403, ALLOWED_ORIGIN);
  }

  // Route requests based on ?action= query param (EdgeOne uses exact-path routing,
  // so all requests hit /chat-history and we dispatch on the action parameter).
  const url = new URL(request.url);
  const action = url.searchParams.get('action');

  try {
    if (action === 'get' && request.method === 'GET') {
      return await handleGetHistory(request, env, JWT_SECRET, ALLOWED_ORIGIN);
    } else if (action === 'delete' && request.method === 'DELETE') {
      return await handleDeleteHistory(request, env, JWT_SECRET, ALLOWED_ORIGIN);
    } else {
      return jsonResponse({ error: 'Endpoint not found' }, 404, ALLOWED_ORIGIN);
    }
  } catch (err) {
    console.error('[chat-history] Unhandled error:', err);
    return jsonResponse({ error: 'Internal server error' }, 500, ALLOWED_ORIGIN);
  }
}

// ============================================================================
// GET CHAT HISTORY
// ============================================================================

/**
 * GET /functions/chat-history/get?limit=50&offset=0
 * Retrieves user's chat history, ordered newest first.
 * Returns: { messages: Array<{id, role, content, created_at}> }
 */
async function handleGetHistory(request, env, jwtSecret, allowedOrigin) {
  // Authenticate (from Authorization header or access_token cookie)
  let token = getBearerToken(request);
  if (!token) {
    const cookies = parseCookies(request);
    token = cookies.access_token;
  }

  if (!token) {
    return jsonResponse({ error: 'Missing Authorization header' }, 401, allowedOrigin);
  }

  const userPayload = await verifyJWT(token, jwtSecret, {
    TOKENS,
    dbCheck: async (uid, tv) => {
      const { data } = await supabaseRest('users', 'GET', `id=eq.${encodeURIComponent(uid)}&select=token_version`);
      return data?.[0]?.token_version === tv;
    },
  });
  if (!userPayload) {
    return jsonResponse({ error: 'Invalid or expired token' }, 401, allowedOrigin);
  }

  const userId = userPayload.userId;
  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 500); // Cap at 500
  const offset = parseInt(url.searchParams.get('offset') || '0');

  try {
    // Get messages (ordered newest first), excluding soft-deleted rows
    const filters = `user_id=eq.${encodeURIComponent(userId)}`
      + `&select=id,role,content,model,tokens_used,created_at`
      + `&deleted_at=is.null`
      + `&order=created_at.desc`
      + `&limit=${limit}&offset=${offset}`;
    const { data: messages, error: messagesError } = await supabaseRest('chat_history', 'GET', filters);

    if (messagesError) throw new Error(messagesError);

    return jsonResponse({
      messages: messages || [],
      total: (messages || []).length,
      limit,
      offset,
    }, 200, allowedOrigin);
  } catch (err) {
    console.error('[chat-history] Failed to retrieve history:', err);
    return jsonResponse({ error: 'Failed to retrieve chat history' }, 500, allowedOrigin);
  }
}

// ============================================================================
// DELETE CHAT HISTORY
// ============================================================================

/**
 * DELETE /functions/chat-history/delete
 * Deletes all chat history for the current user.
 * Returns: { success: true, message: string }
 */
async function handleDeleteHistory(request, env, jwtSecret, allowedOrigin) {
  // Validate CSRF token: double-submit check (header === cookie) plus KV server-issuance check
  const csrfHeader = request.headers.get('X-CSRF-Token');
  const cookies = parseCookies(request);
  const csrfCookie = cookies.csrf_token;

  if (!csrfHeader || !csrfCookie || csrfHeader !== csrfCookie) {
    return jsonResponse({ error: 'Invalid or missing CSRF token' }, 403, allowedOrigin);
  }
  const csrfStored = await TOKENS.get(`csrf:${csrfHeader}`);
  if (!csrfStored) {
    return jsonResponse({ error: 'Invalid or missing CSRF token' }, 403, allowedOrigin);
  }

  // Authenticate (from Authorization header or access_token cookie)
  let token = getBearerToken(request);
  if (!token) {
    token = cookies.access_token;
  }

  if (!token) {
    return jsonResponse({ error: 'Missing Authorization header' }, 401, allowedOrigin);
  }

  const userPayload = await verifyJWT(token, jwtSecret, {
    TOKENS,
    dbCheck: async (uid, tv) => {
      const { data } = await supabaseRest('users', 'GET', `id=eq.${encodeURIComponent(uid)}&select=token_version`);
      return data?.[0]?.token_version === tv;
    },
  });
  if (!userPayload) {
    return jsonResponse({ error: 'Invalid or expired token' }, 401, allowedOrigin);
  }

  const userId = userPayload.userId;

  try {
    const { error: deleteError } = await supabaseRest(
      'chat_history', 'DELETE', `user_id=eq.${encodeURIComponent(userId)}`
    );

    if (deleteError) throw new Error(deleteError);

    return jsonResponse({
      success: true,
      message: 'Chat history deleted',
    }, 200, allowedOrigin);
  } catch (err) {
    console.error('[chat-history] Failed to delete history:', err);
    return jsonResponse({ error: 'Failed to delete chat history' }, 500, allowedOrigin);
  }
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function getBearerToken(request) {
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) {
    return null;
  }
  return auth.slice(7);
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
