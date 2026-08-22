// Shared authentication and crypto utilities for EconIntel edge functions.
// These run server-side only and are used by auth.js and chat.js.

// Argon2id (memory-hard, OWASP-recommended password hash) via vendored hash-wasm
// WASM bundle. The WebAssembly is embedded in argon2.js — no network fetch — and
// is compiled lazily on the first hash call, so importing it stays cheap for the
// chat path (which only needs verifyJWT, never hashing).
import { argon2id, argon2Verify } from './argon2.js';

// ============================================================================
// PASSWORD HASHING — Argon2id (with legacy iterated-SHA-256 verify fallback)
// ============================================================================
// WHY Argon2id: it is memory-hard, so it resists GPU/ASIC cracking in a way that
// plain (iterated) SHA-256 never can. These are the OWASP minimum parameters
// (19 MiB memory, 2 passes, 1 lane). They are constants so they're easy to tune
// after the first live timing test on EdgeOne — if a login ever times out, lower
// ARGON2_MEMORY_KIB first (e.g. 12288 = 12 MiB), but never below ~12 MiB.
const ARGON2_MEMORY_KIB   = 19456; // 19 MiB
const ARGON2_TIME         = 2;     // iterations / passes
const ARGON2_PARALLELISM  = 1;     // lanes
const ARGON2_HASH_LENGTH  = 32;    // output bytes

/**
 * Hash a password with Argon2id.
 * Returns a self-describing PHC string that already embeds the algorithm,
 * version, parameters, salt and hash, e.g.:
 *   $argon2id$v=19$m=19456,t=2,p=1$<saltB64>$<hashB64>
 * comparePassword() reads everything it needs back out of that string.
 * @param {string} password - Plain text password
 * @returns {Promise<string>} Argon2id PHC-encoded hash
 */
export async function hashPassword(password) {
  // 16 random bytes of salt, unique per password.
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return await argon2id({
    password,
    salt,
    parallelism: ARGON2_PARALLELISM,
    iterations:  ARGON2_TIME,
    memorySize:  ARGON2_MEMORY_KIB,
    hashLength:  ARGON2_HASH_LENGTH,
    outputType:  'encoded', // standard PHC string (includes params + salt)
  });
}

// SHA-256 helpers — crypto.subtle.digest is supported on the EdgeOne runtime.
async function _sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}
function _concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * Verify a password against a stored hash.
 * Constant-time comparison using XOR-accumulate pattern to prevent timing attacks.
 * @param {string} password - Plain text password to check
 * @param {string} hash - Stored hash from hashPassword()
 * @returns {Promise<boolean>} True if password matches
 */
export async function comparePassword(password, hash) {
  try {
    const stored = String(hash);

    // ── New scheme: Argon2id ──
    // PHC strings start with "$argon2". argon2Verify re-derives the hash using
    // the parameters baked into the string and does its own constant-time check.
    if (stored.startsWith('$argon2')) {
      return await argon2Verify({ password, hash: stored });
    }

    // ── Legacy scheme: iterated SHA-256 ("sha256i$iter$saltB64$hashB64") ──
    // Kept ONLY so accounts created before the Argon2id upgrade can still sign
    // in. On a successful legacy login, auth.js transparently re-hashes the
    // password to Argon2id (upgrade-on-login), so these fade out over time.
    if (stored.startsWith('sha256i$')) {
      const parts = stored.split('$');
      const iterations = parseInt(parts[1], 10);
      const salt = Uint8Array.from(atob(parts[2]), c => c.charCodeAt(0));
      const storedB64 = parts[3];

      const pw = new TextEncoder().encode(password);
      let acc = await _sha256(_concatBytes(salt, pw));
      for (let i = 1; i < iterations; i++) {
        acc = await _sha256(_concatBytes(acc, salt));
      }
      const computedB64 = btoa(String.fromCharCode.apply(null, acc));

      // Constant-time comparison over the base64 strings
      if (computedB64.length !== storedB64.length) return false;
      let result = 0;
      for (let i = 0; i < computedB64.length; i++) {
        result |= computedB64.charCodeAt(i) ^ storedB64.charCodeAt(i);
      }
      return result === 0;
    }

    // Unknown hash format
    return false;
  } catch (err) {
    console.error('[middleware] comparePassword error:', err);
    return false;
  }
}

/**
 * True if a stored hash uses the modern Argon2id scheme. auth.js uses this to
 * decide whether a legacy account needs upgrading-on-login.
 * @param {string} hash - Stored password hash
 * @returns {boolean}
 */
export function isLegacyHash(hash) {
  return !String(hash).startsWith('$argon2');
}

// ============================================================================
// JWT (JSON Web Token) for stateless sessions
// ============================================================================
// JWTs are signed tokens that the client stores and sends with every request.
// We verify the signature server-side to ensure it wasn't tampered with.
// This avoids needing a session database.

/**
 * Generate a signed JWT.
 * @param {object} payload - Data to encode (e.g., { userId: "123", email: "user@example.com", tv: 1 })
 * @param {string} secret - Signing secret (should be >32 bytes, stored in EdgeOne env var)
 * @param {number} expiresInSeconds - Token lifetime (default 900 = 15 minutes for access token)
 * @returns {Promise<string>} Signed JWT
 */
export async function generateJWT(payload, secret, expiresInSeconds = 900) {
  // JWT structure: header.payload.signature
  // All parts are base64url encoded

  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + expiresInSeconds;

  // Header: { alg: 'HS256', typ: 'JWT' }
  const headerBase64 = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

  // Payload: { ...data, iat: issue time, exp: expiry time }
  const payloadObj = { ...payload, iat: now, exp: expiresAt };
  const payloadBase64 = btoa(JSON.stringify(payloadObj))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

  // Signature: HMAC-SHA256(header.payload, secret)
  const message = `${headerBase64}.${payloadBase64}`;
  const encoder = new TextEncoder();
  const keyBuffer = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signatureBuffer = await crypto.subtle.sign('HMAC', keyBuffer, encoder.encode(message));
  const signatureBase64 = btoa(String.fromCharCode.apply(null, new Uint8Array(signatureBuffer)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

  return `${message}.${signatureBase64}`;
}

/**
 * Verify and decode a JWT.
 * Checks signature, expiry, algorithm, and token_version (session invalidation).
 * @param {string} token - JWT to verify
 * @param {string} secret - Signing secret (must match the one used to generate)
 * @param {object} options - Additional verification options
 *   - db: Database connection to verify token_version
 *   - env: EdgeOne environment (for KV blacklist check)
 * @returns {Promise<object|null>} Decoded payload if valid, null if invalid or expired
 */
export async function verifyJWT(token, secret, options = {}) {
  try {
    const [headerBase64, payloadBase64, signatureBase64] = token.split('.');
    if (!headerBase64 || !payloadBase64 || !signatureBase64) {
      return null; // Invalid format
    }

    // Verify signature
    const message = `${headerBase64}.${payloadBase64}`;
    const encoder = new TextEncoder();
    const keyBuffer = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );
    const signatureBinary = Uint8Array.from(atob(signatureBase64.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    const isValid = await crypto.subtle.verify('HMAC', keyBuffer, signatureBinary, encoder.encode(message));
    if (!isValid) {
      return null; // Signature doesn't match
    }

    // Decode header and payload
    const headerJSON = atob(headerBase64.replace(/-/g, '+').replace(/_/g, '/'));
    const header = JSON.parse(headerJSON);
    const payloadJSON = atob(payloadBase64.replace(/-/g, '+').replace(/_/g, '/'));
    const payload = JSON.parse(payloadJSON);

    // Verify algorithm (prevent algorithm confusion attacks)
    if (header.alg !== 'HS256' || header.typ !== 'JWT') {
      return null; // Invalid algorithm or type
    }

    // Check expiry
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
      return null; // Token expired
    }

    // Check token blacklist (for logged-out tokens)
    if (options.TOKENS) {
      const blacklisted = await options.TOKENS.get(`blacklist:${token}`);
      if (blacklisted) {
        return null; // Token is blacklisted
      }
    }

    // Verify token_version against the database.
    // If payload.tv doesn't match the DB row, the session was revoked via
    // logout-all or password reset — reject immediately instead of waiting
    // for the 15-min expiry. Fail-open on DB errors to avoid locking out
    // users during transient DB downtime.
    if (options.dbCheck && payload.userId) {
      try {
        const valid = await options.dbCheck(payload.userId, payload.tv);
        if (!valid) return null; // token_version mismatch → session was revoked
      } catch (err) {
        // SECURITY (M1 — fail CLOSED): if we cannot confirm the token_version
        // against the DB, we must NOT assume the token is still valid. The old
        // code failed OPEN here (swallowed the error and returned the payload),
        // which meant a revoked session (logout-all / password reset) would still
        // be accepted during any transient Supabase error. Rejecting instead means
        // a DB outage logs users out (they just sign in again) rather than
        // honouring tokens we can no longer verify.
        console.warn('[middleware] token_version DB check failed, failing closed:', err);
        return null;
      }
    }

    return payload;
  } catch (err) {
    console.error('[middleware] verifyJWT error:', err);
    return null;
  }
}

// ============================================================================
// UTILITY: Generate random ID for users and tokens
// ============================================================================

/**
 * Generate a random ID suitable for user IDs or tokens.
 * @returns {string} Random base64 ID (32 bytes → ~43 chars)
 */
export function generateId() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode.apply(null, bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/**
 * Hash an IP address for storage (not reversible).
 * @param {string} ip - IP address
 * @returns {Promise<string>} SHA-256 hash of IP
 */
export async function hashIP(ip) {
  const encoder = new TextEncoder();
  const data = encoder.encode(ip);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode.apply(null, new Uint8Array(hashBuffer))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// ============================================================================
// UTILITY: Resolve which Supabase key the backend should use
// ============================================================================
/**
 * Pick the Supabase API key for server-side REST calls.
 *
 * BACKGROUND: Row Level Security (RLS) is the thing that makes a Supabase key
 * safe to expose. Today RLS is OFF and the functions use the ANON key, so the
 * anon key is the ONLY guard on the whole database — if it ever leaks, every
 * table is readable. The fix is to turn RLS ON and have the backend use the
 * SERVICE-ROLE key (which bypasses RLS), so a leaked anon key becomes useless.
 *
 * EdgeOne refuses to store the raw service_role JWT ("value contains unsecurity
 * string"), so we store it base64-WRAPPED in SUPABASE_SERVICE_KEY_B64 and decode
 * it here at runtime.
 *
 * BACKWARD-COMPATIBLE BY DESIGN: if SUPABASE_SERVICE_KEY_B64 is not set (or can't
 * be decoded) we fall back to the anon key — so deploying this code changes
 * NOTHING until you both (a) set the env var and (b) enable RLS. That lets you
 * roll the change out in safe, separately-reversible steps.
 *
 * @param {object} env - EdgeOne environment bindings
 * @returns {string} the Supabase key to use
 */
export function resolveSupabaseKey(env) {
  // PREFERRED: Supabase's new-format secret key (`sb_secret_...`).
  //
  // Why this exists now and did not before: EdgeOne refuses to store the LEGACY
  // service_role key, because that key is a JWT beginning `eyJ...` and trips a
  // content filter ("value contains unsecurity string") — which is the entire
  // reason this project ran on the anon key server-side, and therefore the
  // reason RLS is off on all seven public tables. `sb_secret_...` is not a JWT
  // and is a completely different string shape, so it saves normally. That
  // removes the constraint the whole design was bent around.
  //
  // No base64 wrapper needed, so no decode step that can fail silently.
  if (env.SUPABASE_SECRET_KEY) return env.SUPABASE_SECRET_KEY.trim();

  // LEGACY workaround, kept so an existing deployment does not regress: the old
  // service_role JWT, base64-wrapped by hand to get past that same filter.
  if (env.SUPABASE_SERVICE_KEY_B64) {
    try {
      // .trim() guards against a trailing newline accidentally pasted into the
      // dashboard; atob() turns the base64 wrapper back into the real JWT.
      return atob(env.SUPABASE_SERVICE_KEY_B64.trim());
    } catch (err) {
      // Misconfigured wrapper — log and fall back so we fail in an obvious way
      // during testing (anon key + RLS-on = denied), not silently.
      console.warn('[middleware] SUPABASE_SERVICE_KEY_B64 set but could not be decoded; falling back to anon key:', err);
    }
  }
  return env.SUPABASE_ANON_KEY;
}

// ============================================================================
// SUPABASE + KV CLIENT — one factory, shared by every edge function
// ============================================================================
/**
 * Build the per-request Supabase helpers from the env bindings.
 *
 * auth.js, chat.js and chat-history.js all need the SAME three things: a thin
 * REST wrapper (supabaseRest), a KV store backed by the kv_store table (TOKENS),
 * and the token_version DB check that verifyJWT uses to reject revoked sessions
 * (dbCheck). They were copy-pasted into all three files; this is the single copy.
 *
 * Returns supabaseUrl/supabaseKey too, for the few places (chat.js retrieval)
 * that hit a REST endpoint directly.
 * @param {object} env - EdgeOne environment bindings
 */
export function makeSupabase(env) {
  const supabaseUrl = env.SUPABASE_URL;
  // Service-role key (base64-wrapped) if configured, else anon key — see
  // resolveSupabaseKey(). This is the only guard on the DB until RLS is on.
  const supabaseKey = resolveSupabaseKey(env);

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
      // 409 (duplicate) is not treated as an error — signup relies on that.
      if (!res.ok && res.status !== 409) {
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

  // KV store backed by the kv_store table (refresh tokens, CSRF, rate limits…).
  const TOKENS = {
    async get(key) {
      const { data } = await supabaseRest('kv_store', 'GET', `key=eq.${encodeURIComponent(key)}&expires_at=gt.${new Date().toISOString()}`);
      return data?.[0]?.value || null;
    },
    async put(key, value, opts) {
      const ttl = opts?.expirationTtl || 3600;
      const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
      // Upsert: kv_store.key is PRIMARY KEY, so Prefer: resolution=merge-duplicates
      // tells PostgREST to UPDATE on conflict instead of returning 409. Plain POST
      // would fail silently on duplicate keys, freezing counters at 1.
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

  // token_version check for verifyJWT: if payload.tv no longer matches the DB row
  // the session was revoked (logout-all / password reset) — reject immediately.
  const dbCheck = async (uid, tv) => {
    const { data } = await supabaseRest('users', 'GET', `id=eq.${encodeURIComponent(uid)}&select=token_version`);
    return data?.[0]?.token_version === tv;
  };

  return { supabaseRest, TOKENS, dbCheck, supabaseUrl, supabaseKey };
}

// ============================================================================
// REQUEST HELPERS — bearer/cookie/token extraction (shared by all functions)
// ============================================================================

/**
 * The client's IP, for rate-limit and quota buckets.
 *
 * SECURITY (H1): use EdgeOne's trusted EO-Connecting-IP header. EdgeOne sets it
 * to the real client IP on every request and — per Tencent's docs — it CANNOT be
 * overridden by the client. Earlier code read CF-Connecting-IP (a Cloudflare
 * header that does not exist on EdgeOne) and then fell back to X-Forwarded-For,
 * which IS attacker-controlled — so anyone could rotate XFF to mint a fresh
 * rate-limit / quota bucket per request. We deliberately do NOT fall back to
 * X-Forwarded-For. If EO-Connecting-IP is absent we use a single shared
 * 'unknown' bucket, which fails safe (over-restrictive) rather than open.
 *
 * Lives here, not in each function, so this choice of trusted header has exactly
 * one home — auth.js and chat.js previously carried their own copies.
 */
export function getClientIP(request) {
  return request.headers.get('EO-Connecting-IP') || 'unknown';
}

/** Extract the Bearer token from the Authorization header, or null. */
export function getBearerToken(request) {
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) return null;
  return auth.slice(7); // strip "Bearer "
}

/** Parse the Cookie header into a plain { name: value } object. */
export function parseCookies(request) {
  const cookies = {};
  const cookieHeader = request.headers.get('Cookie');
  if (!cookieHeader) return cookies;
  cookieHeader.split(';').forEach(cookie => {
    const [key, value] = cookie.trim().split('=');
    if (key && value) cookies[key] = decodeURIComponent(value);
  });
  return cookies;
}

/**
 * The access token, from the Authorization header or — since the real client
 * can't read the HttpOnly access_token cookie to set that header — the cookie.
 */
export function getToken(request) {
  return getBearerToken(request) || parseCookies(request).access_token || null;
}

// ============================================================================
// UTILITY: JSON response helper
// ============================================================================

/**
 * Helper to return JSON responses with CORS + security headers.
 * @param {object} obj - Data to return
 * @param {number} status - HTTP status code
 * @param {string} allowedOrigin - CORS origin to allow
 * @param {object} extraHeaders - Additional headers to merge
 * @returns {Response} HTTP response
 */
export function jsonResponse(obj, status = 200, allowedOrigin = '*', extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': allowedOrigin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS, GET, DELETE, PUT',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-CSRF-Token',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      ...extraHeaders,
    },
  });
}

/**
 * Handle CORS preflight requests with security headers.
 * @param {string} allowedOrigin - CORS origin to allow
 * @returns {Response} HTTP 204 with CORS + security headers
 */
export function corsPreflightResponse(allowedOrigin = '*') {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': allowedOrigin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS, GET, DELETE, PUT',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-CSRF-Token',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'",
    },
  });
}
