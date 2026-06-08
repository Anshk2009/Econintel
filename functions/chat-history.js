// EconIntel — Chat History Function
// Handles retrieving and managing user chat history.
// Deploy to: functions/chat-history.js in your EdgeOne project.

import { verifyJWT, jsonResponse, corsPreflightResponse } from './middleware.js';

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

  // Route requests based on method
  const url = new URL(request.url);
  const path = url.pathname;

  try {
    if (path === '/functions/chat-history/get' && request.method === 'GET') {
      return await handleGetHistory(request, env, JWT_SECRET, ALLOWED_ORIGIN);
    } else if (path === '/functions/chat-history/delete' && request.method === 'DELETE') {
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

  const userPayload = await verifyJWT(token, jwtSecret, { TOKENS });
  if (!userPayload) {
    return jsonResponse({ error: 'Invalid or expired token' }, 401, allowedOrigin);
  }

  const userId = userPayload.userId;
  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 500); // Cap at 500
  const offset = parseInt(url.searchParams.get('offset') || '0');

  try {
    // Get total message count
    const { count: total, error: countError } = await supabase
      .from('chat_history')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId);

    if (countError) throw countError;

    // Get messages (ordered newest first)
    const { data: messages, error: messagesError } = await supabase
      .from('chat_history')
      .select('id, role, content, model, tokens_used, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (messagesError) throw messagesError;

    return jsonResponse({
      messages: messages || [],
      total: total || 0,
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
  // Phase 6: Validate CSRF token (DELETE is state-modifying)
  const csrfHeader = request.headers.get('X-CSRF-Token');
  const cookies = parseCookies(request);
  const csrfCookie = cookies.csrf_token;

  if (!csrfHeader || !csrfCookie || csrfHeader !== csrfCookie) {
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

  const userPayload = await verifyJWT(token, jwtSecret, { TOKENS });
  if (!userPayload) {
    return jsonResponse({ error: 'Invalid or expired token' }, 401, allowedOrigin);
  }

  const userId = userPayload.userId;

  try {
    const { error: deleteError } = await supabase
      .from('chat_history')
      .delete()
      .eq('user_id', userId);

    if (deleteError) throw deleteError;

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
