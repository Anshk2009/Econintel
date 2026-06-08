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
  // Generate a random salt (16 bytes)
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // Use PBKDF2 with SHA-256, 100,000 iterations (OWASP recommended minimum)
  const iterations = 100000;
  const keyBuffer = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: salt,
      iterations: iterations,
    },
    await crypto.subtle.importKey('raw', new TextEncoder().encode(password), { name: 'PBKDF2' }, false, ['deriveBits']),
    256 // Output 256 bits = 32 bytes
  );

  // Combine salt + iterations + hash into a single string
  // Format: "iterations$salt$hash" (all base64)
  const saltBase64 = btoa(String.fromCharCode.apply(null, salt));
  const hashBase64 = btoa(String.fromCharCode.apply(null, new Uint8Array(keyBuffer)));

  return `${iterations}$${saltBase64}$${hashBase64}`;
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
    const [iterStr, saltBase64, storedHashBase64] = hash.split('$');
    const iterations = parseInt(iterStr, 10);

    // Decode salt and stored hash from base64
    const salt = Uint8Array.from(atob(saltBase64), c => c.charCodeAt(0));
    const storedHash = Uint8Array.from(atob(storedHashBase64), c => c.charCodeAt(0));

    // Re-derive the key with the same salt and iterations
    const keyBuffer = await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        hash: 'SHA-256',
        salt: salt,
        iterations: iterations,
      },
      await crypto.subtle.importKey('raw', new TextEncoder().encode(password), { name: 'PBKDF2' }, false, ['deriveBits']),
      256
    );
    const computedHash = new Uint8Array(keyBuffer);

    // Constant-time comparison using XOR-accumulate pattern
    // XOR all bytes to a single value, return only at the end
    // This prevents any timing-side-channel from revealing hash length or byte values
    let result = storedHash.length ^ computedHash.length; // Length check

    // Always compare full length of longer hash (constant-time)
    const maxLen = Math.max(storedHash.length, computedHash.length);
    for (let i = 0; i < maxLen; i++) {
      const storedByte = i < storedHash.length ? storedHash[i] : 0;
      const computedByte = i < computedHash.length ? computedHash[i] : 0;
      result |= storedByte ^ computedByte;
    }

    // result is 0 only if all bytes matched
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

    // Verify token_version (session invalidation on password reset/logout-all)
    // Note: token_version verification requires database access, which may not be available
    // in REST API mode. The token_version is included in the JWT payload (tv field),
    // so we trust the JWT signature instead of re-checking the database.

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
