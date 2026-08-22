// EconIntel — Chat History Function
// Handles retrieving and managing user chat history.
// Deploy to: functions/chat-history.js in your EdgeOne project.

import { verifyJWT, jsonResponse, corsPreflightResponse, makeSupabase, getToken, parseCookies, resolveSupabaseKey } from './middleware.js';

// Hoisted to module scope so the top-level handlers (handleGetHistory,
// handleDeleteHistory) can use them — assigned at the top of onRequest.
let supabaseRest, TOKENS, dbCheck;

/**
 * Authenticate a request: token from the Authorization header or the
 * access_token cookie, then a full verifyJWT (signature, expiry, logout
 * blacklist, token_version revocation).
 *
 * All three handlers in this file did this identically; one copy means the auth
 * rules can't drift apart between them. Reads the module-scope TOKENS/dbCheck,
 * which onRequest assigns before any handler runs.
 *
 * @returns {{ userId: string, payload: object }} on success,
 *          or {@code { res: Response }} — an already-built 401 the caller returns as-is.
 */
async function requireUser(request, jwtSecret, allowedOrigin) {
  const token = getToken(request);
  if (!token) {
    return { res: jsonResponse({ error: 'Missing Authorization header' }, 401, allowedOrigin) };
  }
  const payload = await verifyJWT(token, jwtSecret, { TOKENS, dbCheck });
  if (!payload) {
    return { res: jsonResponse({ error: 'Invalid or expired token' }, 401, allowedOrigin) };
  }
  return { userId: payload.userId, payload };
}

export async function onRequest(context) {
  const { request, env } = context;

  // Fail loud if config missing
  // SECURITY (L2): reject a short/guessable HS256 secret — it could be brute-forced
  // offline to forge valid JWTs. Require >= 32 chars.
  if (!env.JWT_SECRET || env.JWT_SECRET.length < 32) throw new Error('JWT_SECRET missing or too short (need >= 32 chars)');
  if (!env.ALLOWED_ORIGIN) throw new Error('ALLOWED_ORIGIN not configured');
  if (!env.SUPABASE_URL) throw new Error('SUPABASE_URL not configured');
  // Any usable key will do — SUPABASE_SECRET_KEY (preferred), the legacy
  // base64 wrapper, or anon. Checked through resolveSupabaseKey so this guard
  // can never disagree with what makeSupabase actually uses: hardcoding
  // SUPABASE_ANON_KEY here meant the anon key stayed MANDATORY even once it
  // was unused, so removing it after the switch would throw on every request.
  if (!resolveSupabaseKey(env)) throw new Error('No Supabase key configured — set SUPABASE_SECRET_KEY');

  const JWT_SECRET = env.JWT_SECRET;
  const ALLOWED_ORIGIN = env.ALLOWED_ORIGIN;

  // Supabase REST + KV helpers (shared factory in middleware.js). Assigned to the
  // module-scoped bindings so the top-level handlers below can use them.
  ({ supabaseRest, TOKENS, dbCheck } = makeSupabase(env));

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
    } else if (action === 'conversations' && request.method === 'GET') {
      // Grouped thread list for the sidebar (one entry per conversation_id)
      return await handleListConversations(request, env, JWT_SECRET, ALLOWED_ORIGIN);
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
  const auth = await requireUser(request, jwtSecret, allowedOrigin);
  if (auth.res) return auth.res;
  const userId = auth.userId;

  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 500); // Cap at 500
  const offset = parseInt(url.searchParams.get('offset') || '0');
  // Optional: restrict to a single conversation thread. Only the threaded UI
  // sends this; it requires the conversation_id column (migration 0005).
  const conversationId = url.searchParams.get('conversation_id');

  try {
    // Get messages (ordered newest first), excluding soft-deleted rows
    let filters = `user_id=eq.${encodeURIComponent(userId)}`
      + `&select=id,role,content,model,tokens_used,created_at`
      + `&deleted_at=is.null`
      + `&order=created_at.desc`
      + `&limit=${limit}&offset=${offset}`;
    // Scope to one thread when requested
    if (conversationId) {
      filters += `&conversation_id=eq.${encodeURIComponent(conversationId)}`;
    }
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
// LIST CONVERSATIONS (grouped threads for the sidebar)
// ============================================================================

/**
 * GET /functions/chat-history?action=conversations
 * Returns one entry per conversation thread, newest first:
 *   { conversations: [{ conversation_id, title, last_at, count }] }
 * title = the thread's FIRST user question. PostgREST has no easy GROUP BY over
 * REST, so we fetch the user's recent rows and group them here in JS (volumes
 * are small). Requires the conversation_id column (migration 0005).
 */
async function handleListConversations(request, env, jwtSecret, allowedOrigin) {
  const auth = await requireUser(request, jwtSecret, allowedOrigin);
  if (auth.res) return auth.res;
  const userId = auth.userId;

  try {
    // Pull the user's recent threaded rows, newest first. conversation_id=not.is.null
    // skips legacy flat history (which has no thread to reopen).
    const filters = `user_id=eq.${encodeURIComponent(userId)}`
      + `&select=role,content,conversation_id,created_at`
      + `&deleted_at=is.null`
      + `&conversation_id=not.is.null`
      + `&order=created_at.desc`
      + `&limit=400`;
    const { data: rows, error } = await supabaseRest('chat_history', 'GET', filters);
    if (error) throw new Error(error);

    // Group in JS. Rows are DESC (newest first), so:
    //  - the first row seen for a thread carries its latest timestamp (last_at)
    //  - overwriting title on every user row leaves the EARLIEST user message
    //    (the original question) as the final title.
    const byThread = new Map();
    for (const r of (rows || [])) {
      const cid = r.conversation_id;
      if (!byThread.has(cid)) {
        byThread.set(cid, { conversation_id: cid, title: '', last_at: r.created_at, count: 0 });
      }
      const t = byThread.get(cid);
      t.count += 1;
      if (r.role === 'user' && typeof r.content === 'string') {
        t.title = r.content.slice(0, 200); // overwritten down to the earliest question
      }
    }

    // Map → array, newest thread first, cap the list.
    const conversations = Array.from(byThread.values())
      .map(t => ({ ...t, title: t.title || 'Untitled chat' }))
      .sort((a, b) => new Date(b.last_at) - new Date(a.last_at))
      .slice(0, 30);

    return jsonResponse({ conversations }, 200, allowedOrigin);
  } catch (err) {
    console.error('[chat-history] Failed to list conversations:', err);
    return jsonResponse({ error: 'Failed to list conversations' }, 500, allowedOrigin);
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
  // Double-submit CSRF check first (header === cookie). Cheap, no DB hit.
  const csrfHeader = request.headers.get('X-CSRF-Token');
  const cookies = parseCookies(request);
  const csrfCookie = cookies.csrf_token;

  if (!csrfHeader || !csrfCookie || csrfHeader !== csrfCookie) {
    return jsonResponse({ error: 'Invalid or missing CSRF token' }, 403, allowedOrigin);
  }

  // Authenticate BEFORE the final CSRF check, so we know which user to bind the
  // CSRF token to (M3).
  const auth = await requireUser(request, jwtSecret, allowedOrigin);
  if (auth.res) return auth.res;
  const userId = auth.userId;

  // SECURITY (M3): the CSRF token must have been issued by this server AND belong
  // to THIS user. New tokens store { userId } as JSON; legacy tokens stored the
  // bare token string, for which we accept mere existence (back-compat until they
  // expire). This stops one user's CSRF token authorising another user's delete.
  const csrfStored = await TOKENS.get(`csrf:${csrfHeader}`);
  if (!csrfStored) {
    return jsonResponse({ error: 'Invalid or missing CSRF token' }, 403, allowedOrigin);
  }
  try {
    const parsed = JSON.parse(csrfStored);
    if (parsed && typeof parsed === 'object' && 'userId' in parsed && parsed.userId !== userId) {
      return jsonResponse({ error: 'Invalid or missing CSRF token' }, 403, allowedOrigin);
    }
  } catch { /* legacy non-JSON value — existence check above is sufficient */ }

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

// getToken / parseCookies are imported from middleware.js.
