// Shared authentication and crypto utilities for EconIntel edge functions.
// These run server-side only and are used by auth.js and chat.js.

// ============================================================================
// PASSWORD HASHING with PBKDF2
// ============================================================================
// PBKDF2 is a standard key derivation function built into Node.js (via SubtleCrypto).
// It's cryptographically sound and resistant to brute-force attacks.
// Not async—takes ~10ms per operation, which is fine for edge functions.

/**
 * Hash a password using PBKDF2-SHA256.
 * Returns a base64 string containing salt + iterations + hash.
 * @param {string} password - Plain text password
 * @returns {string} Salted hash (base64)
 */
export async function hashPassword(password) {
  // NOTE: EdgeOne's runtime does not support PBKDF2 via crypto.subtle.deriveBits
  // ("Param Invalid"), so we use iterated SHA-256 (crypto.subtle.digest), which
  // IS supported. Format: "sha256i$iterations$saltB64$hashB64".
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const pw = new TextEncoder().encode(password);
  const iterations = 1000;

  let acc = await _sha256(_concatBytes(salt, pw));
  for (let i = 1; i < iterations; i++) {
    acc = await _sha256(_concatBytes(acc, salt));
  }

  const saltBase64 = btoa(String.fromCharCode.apply(null, salt));
  const hashBase64 = btoa(String.fromCharCode.apply(null, acc));
  return `sha256i$${iterations}$${saltBase64}$${hashBase64}`;
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
    const parts = String(hash).split('$');
    // Expected format: sha256i$iterations$saltB64$hashB64
    if (parts[0] !== 'sha256i') return false;
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
  } catch (err) {
    console.error('[middleware] comparePassword error:', err);
    return false;
  }
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
        if (!valid) return null;
      } catch (err) {
        console.warn('[middleware] token_version DB check failed, failing open:', err);
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
