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
// SECURITY (SEC-18): who issued a token and who it is for. Without these, any
// other token ever signed with JWT_SECRET (a debug script, a future service, an
// email-link token) would be accepted as a login session.
const JWT_ISSUER = 'econintel';
const JWT_AUDIENCE = 'econintel-web';

export async function generateJWT(payload, secret, expiresInSeconds = 900) {
  // JWT structure: header.payload.signature
  // All parts are base64url encoded

  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + expiresInSeconds;

  // Header: { alg: 'HS256', typ: 'JWT' }
  const headerBase64 = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

  // Payload: { ...data, iss, aud, iat: issue time, exp: expiry time }.
  // iss/aud (SEC-18) bind the token to THIS app; verifyJWT requires both.
  // jti: a random id per token (QA-01 finding). Without it two tokens minted in
  // the same second for the same user were byte-identical, so logging out on one
  // device blacklisted the other's — and the blacklist had to store the whole
  // bearer token as its key. Now it stores this id.
  const payloadObj = { ...payload, jti: generateId(), iss: JWT_ISSUER, aud: JWT_AUDIENCE, iat: now, exp: expiresAt };
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

    // Check expiry. SECURITY (SEC-18): exp is REQUIRED. This used to be
    // `payload.exp && payload.exp < now`, so a signed token with no exp claim
    // never expired. generateJWT always sets one; refuse anything that lacks it.
    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== 'number' || payload.exp < now) {
      return null; // Token expired, or carries no expiry at all
    }
    // Issued by us, for us (SEC-18). Tokens minted before this check existed
    // carry neither claim and are refused once — the client renews through its
    // refresh cookie (opaque, unaffected) and carries on.
    if (payload.iss !== JWT_ISSUER || payload.aud !== JWT_AUDIENCE) {
      return null;
    }

    // Check token blacklist (for logged-out tokens)
    // Every token we mint carries a jti; one without it was not minted here.
    if (typeof payload.jti !== 'string' || !payload.jti) return null;
    if (options.TOKENS) {
      const blacklisted = await options.TOKENS.get(`blacklist:${payload.jti}`);
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
 * The Supabase key every server-side REST call uses: SUPABASE_SECRET_KEY
 * (`sb_secret_…`), which bypasses RLS. Nothing else.
 *
 * HISTORY, because the reason matters: EdgeOne refuses to store the legacy
 * service_role key (a JWT starting `eyJ…` trips its "unsecurity string"
 * filter), so for months the functions ran on the ANON key and RLS stayed off.
 * A base64-wrapped copy of the legacy key was the first workaround; Supabase's
 * new non-JWT secret key removed the problem, and RLS has been ON for every
 * table, with no policies, since 2026-08-22.
 *
 * So the anon key can no longer do anything here, and falling back to it
 * (as this used to, after the base64 wrapper) only turned "the secret is
 * missing" into confusing denials and silently empty reads (audit QA-03).
 * Without the secret key this returns undefined, and each function's startup
 * check throws a named error instead.
 *
 * @param {object} env - EdgeOne environment bindings
 * @returns {string|undefined} the secret key, trimmed
 */
export function resolveSupabaseKey(env) {
  // .trim(): a trailing space or newline pasted into the dashboard otherwise
  // breaks every request in a way that looks like a dead key.
  return env.SUPABASE_SECRET_KEY ? env.SUPABASE_SECRET_KEY.trim() : undefined;
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
// Set once kv_incr() has answered 404 (migration 0013 not applied), so every
// later counter in this isolate skips straight to the fallback instead of paying
// a wasted round trip per increment.
let kvIncrMissing = false;

export function makeSupabase(env) {
  const supabaseUrl = env.SUPABASE_URL;
  // The secret key (bypasses RLS) — see resolveSupabaseKey().
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
    /**
     * Add 1 to a counter and return the NEW value (audit SEC-02).
     *
     * Quotas used to be get-then-put, so a burst of parallel requests all read
     * the same count and all got through. kv_incr() (migration 0013) does the
     * increment in ONE statement, so every caller sees a distinct number and the
     * caller compares `n > limit` — no window for a race.
     *
     * Until 0013 is applied the RPC answers 404; we remember that for the life of
     * the isolate and fall back to the old read-then-write, so deploying this code
     * before the migration changes nothing. Any other RPC failure also falls back
     * (a rate limiter that throws would take chat down with it).
     */
    async incr(key, ttlSeconds) {
      if (!kvIncrMissing) {
        try {
          const res = await fetch(`${supabaseUrl}/rest/v1/rpc/kv_incr`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${supabaseKey}`,
              'apikey': supabaseKey,
            },
            body: JSON.stringify({ p_key: key, p_ttl_seconds: ttlSeconds }),
          });
          if (res.ok) return Number(await res.json());
          if (res.status === 404) kvIncrMissing = true;
          else console.warn('[middleware] kv_incr failed, using fallback:', res.status);
        } catch (err) {
          console.warn('[middleware] kv_incr error, using fallback:', err);
        }
      }
      // ponytail: fallback is the old racy read-then-write — the race is only
      // closed once migration 0013 is applied.
      const n = parseInt(await this.get(key) || '0', 10) + 1;
      await this.put(key, String(n), { expirationTtl: ttlSeconds });
      return n;
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
  const raw = (request.headers.get('EO-Connecting-IP') || '').trim();
  if (!raw) return 'unknown';
  return rateLimitBucket(raw);
}

/**
 * SECURITY (SEC-02): collapse an IPv6 address to its /64 network.
 *
 * Every per-IP limit used to key on the FULL address. A single home IPv6
 * connection is assigned a whole /64 (2^64 addresses), so rotating the last 64
 * bits minted a fresh guest / free-tier / signup / login bucket per request —
 * enough for one person to drain the NVIDIA key every user shares. One /64 is
 * one customer, so that is the bucket.
 *
 * IPv4 is returned unchanged. IPv4-mapped IPv6 (::ffff:1.2.3.4) becomes the
 * IPv4 address, so the same client cannot hold two buckets. Anything that does
 * not parse is returned as-is (still a bucket, just a less clever one).
 */
function rateLimitBucket(ip) {
  if (!ip.includes(':')) return ip;                        // IPv4
  const lower = ip.toLowerCase().replace(/%.*$/, '');       // drop any zone id
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return mapped[1];
  // Expand "::" so every address has exactly 8 groups, then keep the first 4.
  const [head, tail = ''] = lower.split('::');
  const h = head ? head.split(':') : [];
  const t = lower.includes('::') && tail ? tail.split(':') : [];
  const groups = lower.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  if (groups.length !== 8) return lower;
  return groups.slice(0, 4).map(g => (parseInt(g, 16) || 0).toString(16)).join(':') + '::/64';
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
 * The ONE origin to put in Access-Control-Allow-Origin (audit SEC-18).
 * ALLOWED_ORIGIN may be a comma-separated list, and the raw list is not a valid
 * header value — a browser treats "https://a, https://b" as a mismatch. Every
 * function already rejects requests whose Origin is not on the list, so the
 * first (canonical) entry is the right answer for everything that gets this far.
 * ponytail: echo the matched request Origin instead if a second origin ever
 * needs cross-origin access in its own right.
 */
export function corsOrigin(allowedOrigin) {
  return String(allowedOrigin || '').split(',')[0].trim() || '*';
}

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
      'Access-Control-Allow-Origin': corsOrigin(allowedOrigin),
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
      'Access-Control-Allow-Origin': corsOrigin(allowedOrigin),
      'Access-Control-Allow-Methods': 'POST, OPTIONS, GET, DELETE, PUT',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-CSRF-Token',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'",
    },
  });
}
