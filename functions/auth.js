// EconIntel — Authentication Edge Function
// Handles user signup, login, logout, password reset, and email verification.
// Deploy to: functions/auth.js in your EdgeOne project.
//
// Requires:
//   - Supabase PostgreSQL database for users, auth
//   - EdgeOne KV storage for reset/verification tokens (context.TOKENS)
//   - Environment variables: JWT_SECRET, ALLOWED_ORIGIN, SMTP_* (for emails)

import {
  hashPassword,
  comparePassword,
  generateJWT,
  verifyJWT,
  generateId,
  hashIP,
  jsonResponse,
  corsPreflightResponse,
} from './middleware.js';

// Rate limiting thresholds
const RATE_LIMITS = {
  failedLogin: { max: 5, window: 900 },
  loginAttempts: { max: 20, window: 3600 },
  signupAttempts: { max: 3, window: 3600 },
  resetAttempts: { max: 3, window: 3600 },
};

// Get client IP from request
function getClientIP(request) {
  return request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown';
}

// Check rate limit using KV
async function checkRateLimit(kv, key, maxAttempts, windowSeconds) {
  const current = parseInt(await kv.get(key) || '0', 10);
  if (current >= maxAttempts) {
    return { limited: true, remaining: 0, retryAfter: windowSeconds };
  }
  return { limited: false, remaining: maxAttempts - current - 1, retryAfter: null };
}

// Increment rate limit counter
async function incrementRateLimit(kv, key, windowSeconds) {
  const current = parseInt(await kv.get(key) || '0', 10);
  await kv.put(key, String(current + 1), { expirationTtl: windowSeconds });
}

// Hoisted to module scope so the top-level handler functions (handleSignup,
// handleLogin, …) can use them. They are (re)assigned at the top of onRequest,
// closing over env-derived Supabase config which is constant per deployment.
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

  // Supabase REST API helper (no npm packages needed)
  const supabaseUrl = env.SUPABASE_URL;
  // EdgeOne rejects service_role key ("value contains unsecurity string") — anon key only.
  // RLS is disabled on all tables so anon key has full access server-side.
  const supabaseKey = env.SUPABASE_ANON_KEY;

  // REST API helper function (assigned to the module-scoped binding above)
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
      if (!res.ok && res.status !== 409) {
        console.warn(`[supabase] ${method} ${table} failed:`, res.status, await res.text());
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

  // CORS preflight
  if (request.method === 'OPTIONS') {
    return corsPreflightResponse(ALLOWED_ORIGIN);
  }

  // Enforce Origin: if present and wrong, reject immediately.
  // Absent Origin (same-origin browser fetch, curl) is allowed through.
  const origin = request.headers.get('Origin');
  const allowedOrigins = ALLOWED_ORIGIN.split(',').map(o => o.trim());
  if (origin && !allowedOrigins.includes(origin)) {
    return jsonResponse({ error: 'Forbidden' }, 403, ALLOWED_ORIGIN);
  }

  // Route requests based on ?action= query param (EdgeOne uses exact-path routing,
  // so all auth requests hit /auth and we dispatch on the action parameter).
  const url = new URL(request.url);
  const action = url.searchParams.get('action');

  try {
    if (action === 'signup' && request.method === 'POST') {
      return await handleSignup(request, env, JWT_SECRET, ALLOWED_ORIGIN);
    } else if (action === 'login' && request.method === 'POST') {
      return await handleLogin(request, env, JWT_SECRET, ALLOWED_ORIGIN);
    } else if (action === 'logout' && request.method === 'POST') {
      return await handleLogout(request, env, JWT_SECRET, ALLOWED_ORIGIN);
    } else if (action === 'logout-all' && request.method === 'POST') {
      return await handleLogoutAll(request, env, JWT_SECRET, ALLOWED_ORIGIN);
    } else if (action === 'reset-password' && request.method === 'POST') {
      return await handleResetPasswordRequest(request, env, ALLOWED_ORIGIN);
    } else if (action === 'verify-reset' && request.method === 'POST') {
      return await handleVerifyReset(request, env, JWT_SECRET, ALLOWED_ORIGIN);
    } else if (action === 'verify-email' && request.method === 'POST') {
      return await handleVerifyEmail(request, env, ALLOWED_ORIGIN);
    } else if (action === 'refresh' && request.method === 'POST') {
      return await handleRefreshToken(request, env, JWT_SECRET, ALLOWED_ORIGIN);
    } else if (action === 'oauth-discord' && request.method === 'GET') {
      // GET because this is a browser navigation (redirect flow), not a fetch.
      // Same URL handles both legs: no ?code= → send user to Discord;
      // with ?code= → Discord sent them back, finish the login.
      return await handleOAuthDiscord(request, env, JWT_SECRET, ALLOWED_ORIGIN);
    } else if (action === 'oauth-google' && request.method === 'GET') {
      // Same two-leg redirect flow as Discord, but against Google's endpoints
      return await handleOAuthGoogle(request, env, JWT_SECRET, ALLOWED_ORIGIN);
    } else {
      return jsonResponse({ error: 'Endpoint not found' }, 404, ALLOWED_ORIGIN);
    }
  } catch (err) {
    console.error('[auth] Unhandled error:', err);
    return jsonResponse({ error: 'Internal server error' }, 500, ALLOWED_ORIGIN);
  }
}

// ============================================================================
// SIGNUP
// ============================================================================

/**
 * POST /functions/auth/signup
 * Creates a new user account.
 * Body: { email: string, password: string, username: string }
 * Returns: { userId: string, jwt: string, message: string }
 */
async function handleSignup(request, env, jwtSecret, allowedOrigin) {
  const clientIP = getClientIP(request);
  const ipKey = `rl:signup:${clientIP}`;

  // IP-based signup rate limit: 3 new accounts per IP per hour.
  // Prevents mass account creation / spam without blocking legitimate users.
  const ipLimit = await checkRateLimit(TOKENS, ipKey, RATE_LIMITS.signupAttempts.max, RATE_LIMITS.signupAttempts.window);
  if (ipLimit.limited) {
    return jsonResponse({ error: 'Too many signup attempts. Try again later.' }, 429, allowedOrigin, { 'Retry-After': String(ipLimit.retryAfter) });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON' }, 400, allowedOrigin);
  }

  const { email, password, username } = body;
  const normalizedEmail = email?.toLowerCase().trim();

  // Validate input
  if (!normalizedEmail || !password || !username) {
    return jsonResponse({ error: 'Missing required fields' }, 400, allowedOrigin);
  }

  if (password.length < 12 || password.length > 128) {
    return jsonResponse({ error: 'Password must be 12-128 characters' }, 400, allowedOrigin);
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) || normalizedEmail.length > 254) {
    return jsonResponse({ error: 'Invalid email format' }, 400, allowedOrigin);
  }

  if (username.length < 3 || username.length > 32) {
    return jsonResponse({ error: 'Username must be 3-32 characters' }, 400, allowedOrigin);
  }

  // Allowlist: only letters, numbers, underscores, hyphens, dots.
  // Prevents < > " ' characters from being stored and later injected into HTML.
  if (!/^[a-zA-Z0-9_.\-]+$/.test(username)) {
    return jsonResponse({ error: 'Username may only contain letters, numbers, underscores, hyphens, and dots' }, 400, allowedOrigin);
  }

  const userId = generateId();

  try {
    // Check if email or username already exists (REST API)
    const existingEmailRes = await supabaseRest('users', 'GET', `email=eq.${encodeURIComponent(normalizedEmail)}&select=id`);
    const existingUsernameRes = await supabaseRest('users', 'GET', `username=ilike.${encodeURIComponent(username)}&select=id`);

    const existingEmail = existingEmailRes.data?.[0];
    const existingUsername = existingUsernameRes.data?.[0];

    // Increment signup counter regardless of outcome so the rate limit counts all attempts
    await incrementRateLimit(TOKENS, ipKey, RATE_LIMITS.signupAttempts.window);

    // Generic response (no user enumeration)
    if (existingEmail || existingUsername) {
      return jsonResponse({ message: 'If account can be created, confirmation email will be sent.' }, 200, allowedOrigin);
    }

    // Phase 9: Check password against HaveIBeenPwned API
    try {
      const isPwned = await checkHaveIBeenPwned(password);
      if (isPwned) {
        return jsonResponse({ error: 'Password has been compromised in known breaches. Please choose a different password.' }, 400, allowedOrigin);
      }
    } catch (err) {
      // Log but don't fail if HIBP is unreachable (graceful degradation)
      console.warn('[auth] HaveIBeenPwned check failed:', err);
    }

    // Hash password with PBKDF2
    const passwordHash = await hashPassword(password);

    // Create user (REST API)
    const { data: insertData, error: insertError } = await supabaseRest('users', 'POST', '', {
      id: userId,
      email: normalizedEmail,
      username: username,
      password_hash: passwordHash,
      plan: 'free',
      token_version: 1,
      created_at: new Date().toISOString()
    });

    if (insertError) throw insertError;

    // Phase 6: short-lived access JWT (15 min) + refresh token + CSRF — identical
    // contract to handleLogin so the frontend logs the user in straight after signup.
    const jwt = await generateJWT(
      { userId, email: normalizedEmail, username, plan: 'free', tv: 1 },
      jwtSecret,
      900
    );
    const refreshToken = generateId();
    await TOKENS.put(`refresh:${refreshToken}`, userId, { expirationTtl: 2592000 });
    const csrfToken = generateId();
    await TOKENS.put(`csrf:${csrfToken}`, csrfToken, { expirationTtl: 86400 });

    const responseBody = JSON.stringify({
      userId,
      username,
      email: normalizedEmail,
      plan: 'free',
      csrfToken,
    });

    // Fix: Set-Cookie must be separate headers — joining with commas breaks cookie parsing
    const signupHeaders = new Headers({
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': allowedOrigin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS, GET, DELETE, PUT',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-CSRF-Token',
      'Access-Control-Allow-Credentials': 'true',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    });
    signupHeaders.append('Set-Cookie', `access_token=${jwt}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=900`);
    signupHeaders.append('Set-Cookie', `refresh_token=${refreshToken}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`);
    signupHeaders.append('Set-Cookie', `csrf_token=${csrfToken}; Path=/; Secure; SameSite=Strict; Max-Age=86400`);
    return new Response(responseBody, { status: 201, headers: signupHeaders });
  } catch (err) {
    console.error('[auth] Signup error:', err);
    return jsonResponse({ error: 'Failed to create account' }, 500, allowedOrigin);
  }
}

// ============================================================================
// LOGIN
// ============================================================================

/**
 * POST /functions/auth/login
 * Authenticates a user and returns a JWT.
 * Body: { email: string, password: string }
 * Returns: { userId: string, jwt: string, username: string, email: string }
 */
async function handleLogin(request, env, jwtSecret, allowedOrigin) {
  const clientIP = getClientIP(request);
  const ipKey = `rl:login:ip:${clientIP}`;

  // Check IP rate limit
  const ipLimit = await checkRateLimit(TOKENS, ipKey, RATE_LIMITS.loginAttempts.max, RATE_LIMITS.loginAttempts.window);
  if (ipLimit.limited) {
    return jsonResponse({ error: 'Too many login attempts' }, 429, allowedOrigin, { 'Retry-After': String(ipLimit.retryAfter) });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON' }, 400, allowedOrigin);
  }

  const { email, password } = body;
  const normalizedEmail = email?.toLowerCase().trim();

  if (!normalizedEmail || !password) {
    return jsonResponse({ error: 'Missing email or password' }, 400, allowedOrigin);
  }

  try {
    // Find user by email (REST API)
    const { data: users, error: fetchError } = await supabaseRest('users', 'GET', `email=eq.${encodeURIComponent(normalizedEmail)}`);
    const user = users?.[0];

    if (fetchError) throw fetchError;

    if (!user || !(await comparePassword(password, user.password_hash))) {
      // Increment failed login counter
      const emailKey = `rl:login:email:${normalizedEmail}`;
      await incrementRateLimit(TOKENS, emailKey, RATE_LIMITS.failedLogin.window);
      await incrementRateLimit(TOKENS, ipKey, RATE_LIMITS.loginAttempts.window);

      // Check email rate limit
      const emailLimit = await checkRateLimit(TOKENS, emailKey, RATE_LIMITS.failedLogin.max, RATE_LIMITS.failedLogin.window);
      if (emailLimit.limited) {
        return jsonResponse({ error: 'Account temporarily locked. Try again later.' }, 429, allowedOrigin, { 'Retry-After': String(emailLimit.retryAfter) });
      }

      return jsonResponse({ error: 'Invalid email or password' }, 401, allowedOrigin);
    }

    // Increment IP counter (for tracking, not limiting on success)
    await incrementRateLimit(TOKENS, ipKey, RATE_LIMITS.loginAttempts.window);

    // Update last login time (REST API - PATCH)
    const { error: updateError } = await supabaseRest('users', 'PATCH', `id=eq.${encodeURIComponent(user.id)}`, { last_login_at: new Date().toISOString() });

    if (updateError) console.warn('[auth] Failed to update login time:', updateError);

    // Phase 6: Generate JWT with 15-minute expiry + refresh token
    const jwt = await generateJWT(
      { userId: user.id, email: user.email, username: user.username, plan: user.plan, tv: user.token_version },
      jwtSecret,
      900 // 15 minutes
    );

    // Phase 6: Generate long-lived refresh token (opaque, stored in KV)
    const refreshToken = generateId();
    await TOKENS.put(`refresh:${refreshToken}`, user.id, { expirationTtl: 2592000 }); // 30 days

    // Phase 6: Generate CSRF token
    const csrfToken = generateId();
    await TOKENS.put(`csrf:${csrfToken}`, csrfToken, { expirationTtl: 86400 }); // 24 hours

    // Phase 6: Set secure cookies + return response
    const responseBody = JSON.stringify({
      userId: user.id,
      username: user.username,
      email: user.email,
      plan: user.plan,
      csrfToken, // Include CSRF token in response for client to verify
    });

    // Fix: Set-Cookie must be separate headers — joining with commas breaks cookie parsing
    const loginHeaders = new Headers({
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': allowedOrigin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS, GET, DELETE, PUT',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-CSRF-Token',
      'Access-Control-Allow-Credentials': 'true',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    });
    loginHeaders.append('Set-Cookie', `access_token=${jwt}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=900`);
    loginHeaders.append('Set-Cookie', `refresh_token=${refreshToken}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`);
    loginHeaders.append('Set-Cookie', `csrf_token=${csrfToken}; Path=/; Secure; SameSite=Strict; Max-Age=86400`);
    return new Response(responseBody, { status: 200, headers: loginHeaders });
  } catch (err) {
    console.error('[auth] Login error:', err);
    return jsonResponse({ error: 'Login failed' }, 500, allowedOrigin);
  }
}

// ============================================================================
// LOGOUT
// ============================================================================

/**
 * POST /functions/auth/logout
 * Invalidates the current session (token blacklist).
 * Headers: Authorization: Bearer <jwt>
 * Returns: { message: string }
 */
async function handleLogout(request, env, jwtSecret, allowedOrigin) {
  // Validate CSRF token (double-submit + KV server-issuance check)
  if (!await validateCSRFToken(request, TOKENS)) {
    return jsonResponse({ error: 'Invalid or missing CSRF token' }, 403, allowedOrigin);
  }

  const token = getBearerToken(request);

  if (!token) {
    return jsonResponse({ error: 'Missing token' }, 401, allowedOrigin);
  }

  // Verify token — includes token_version DB check to catch revoked sessions immediately
  const payload = await verifyJWT(token, jwtSecret, {
    TOKENS,
    dbCheck: async (uid, tv) => {
      const { data } = await supabaseRest('users', 'GET', `id=eq.${encodeURIComponent(uid)}&select=token_version`);
      return data?.[0]?.token_version === tv;
    },
  });
  if (!payload) {
    return jsonResponse({ error: 'Invalid or expired token' }, 401, allowedOrigin);
  }

  // Store token in blacklist (KV) until expiry (TTL in seconds, not minutes)
  const ttl = Math.ceil(payload.exp - Math.floor(Date.now() / 1000));
  if (ttl > 0) {
    try {
      await TOKENS.put(`blacklist:${token}`, '1', { expirationTtl: ttl });
    } catch (err) {
      console.warn('[auth] Failed to blacklist token:', err);
      // Still return success—blacklist is nice-to-have
    }
  }

  // Phase 6: Clear cookies by setting max-age=0
  const responseBody = JSON.stringify({ message: 'Logged out successfully' });

  // Fix: Set-Cookie must be separate headers — joining with commas breaks cookie parsing
  const logoutHeaders = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Credentials': 'true',
  });
  logoutHeaders.append('Set-Cookie', 'access_token=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0');
  logoutHeaders.append('Set-Cookie', 'refresh_token=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0');
  logoutHeaders.append('Set-Cookie', 'csrf_token=; Path=/; Secure; SameSite=Strict; Max-Age=0');
  return new Response(responseBody, { status: 200, headers: logoutHeaders });
}

// ============================================================================
// LOGOUT ALL (Invalidate All Sessions)
// ============================================================================

/**
 * POST /functions/auth/logout-all
 * Invalidates ALL sessions for the current user (bumps token_version).
 * Useful for: password reset, suspected compromise, security event.
 * Headers: Authorization: Bearer <jwt>
 * Returns: { message: string }
 */
async function handleLogoutAll(request, env, jwtSecret, allowedOrigin) {
  // Validate CSRF token (double-submit + KV server-issuance check)
  if (!await validateCSRFToken(request, TOKENS)) {
    return jsonResponse({ error: 'Invalid or missing CSRF token' }, 403, allowedOrigin);
  }

  const token = getBearerToken(request);

  if (!token) {
    return jsonResponse({ error: 'Missing token' }, 401, allowedOrigin);
  }

  // Verify token — includes token_version DB check to catch revoked sessions immediately
  const payload = await verifyJWT(token, jwtSecret, {
    TOKENS,
    dbCheck: async (uid, tv) => {
      const { data } = await supabaseRest('users', 'GET', `id=eq.${encodeURIComponent(uid)}&select=token_version`);
      return data?.[0]?.token_version === tv;
    },
  });
  if (!payload) {
    return jsonResponse({ error: 'Invalid or expired token' }, 401, allowedOrigin);
  }

  const userId = payload.userId;

  try {
    // Fetch current token_version and bump it (REST API)
    const { data: users } = await supabaseRest('users', 'GET', `id=eq.${encodeURIComponent(userId)}&select=token_version`);
    const user = users?.[0];

    if (user) {
      const newVersion = (user.token_version || 1) + 1;
      await supabaseRest('users', 'PATCH', `id=eq.${encodeURIComponent(userId)}`, { token_version: newVersion });
    }

    // Blacklist current token too (in case it's still in the allowlist)
    const ttl = Math.ceil(payload.exp - Math.floor(Date.now() / 1000));
    if (ttl > 0) {
      try {
        await TOKENS.put(`blacklist:${token}`, '1', { expirationTtl: ttl });
      } catch (err) {
        console.warn('[auth] Failed to blacklist token during logout-all:', err);
      }
    }

    return jsonResponse({ message: 'All sessions invalidated' }, 200, allowedOrigin);
  } catch (err) {
    console.error('[auth] Logout-all error:', err);
    return jsonResponse({ error: 'Failed to invalidate sessions' }, 500, allowedOrigin);
  }
}

// ============================================================================
// PASSWORD RESET REQUEST
// ============================================================================

/**
 * POST /functions/auth/reset-password
 * Generates a reset token and sends it to the user's email.
 * Body: { email: string }
 * Returns: { message: string }
 */
async function handleResetPasswordRequest(request, env, allowedOrigin) {
  const clientIP = getClientIP(request);

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON' }, 400, allowedOrigin);
  }

  const { email } = body;
  const normalizedEmail = email?.toLowerCase().trim();

  if (!normalizedEmail) {
    return jsonResponse({ error: 'Missing email' }, 400, allowedOrigin);
  }

  const emailKey = `rl:reset:${normalizedEmail}`;
  const resetLimit = await checkRateLimit(TOKENS, emailKey, RATE_LIMITS.resetAttempts.max, RATE_LIMITS.resetAttempts.window);
  if (resetLimit.limited) {
    return jsonResponse({ error: 'Too many reset attempts. Try again later.' }, 429, allowedOrigin, { 'Retry-After': String(resetLimit.retryAfter) });
  }

  try {
    const { data: _resetUsers } = await supabaseRest('users', 'GET', `email=eq.${encodeURIComponent(normalizedEmail)}&select=id,email`);
    const user = _resetUsers?.[0] || null;

    // Increment counter regardless
    await incrementRateLimit(TOKENS, emailKey, RATE_LIMITS.resetAttempts.window);

    // Generic response (no user enumeration)
    if (!user) {
      return jsonResponse({ message: 'If this email exists, a reset link has been sent.' }, 200, allowedOrigin);
    }

    // Generate reset token
    const resetToken = generateId();
    const ipHash = await hashIP(clientIP);

    // Store token in KV (expires in 1 hour = 3600 seconds)
    // No IP binding — user may open the reset link on a different device/network
    await TOKENS.put(`reset:${resetToken}`, user.id, { expirationTtl: 3600 });

    // Send reset email via Resend (https://resend.com).
    // Requires RESEND_API_KEY in EdgeOne env vars.
    // When you buy a domain: verify it in Resend dashboard and update the
    // `from` field below to something like: EconIntel <noreply@yourdomain.com>
    const resetLink = `https://econintel.edgeone.app/reset-password.html?token=${resetToken}`;
    if (env.RESEND_API_KEY) {
      try {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.RESEND_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: 'EconIntel <onboarding@resend.dev>',   // swap for your domain once verified
            to: normalizedEmail,
            subject: 'Reset your EconIntel password',
            html: `
              <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:2rem">
                <h2 style="margin:0 0 1rem">Reset your password</h2>
                <p style="color:#555;margin:0 0 1.5rem">
                  We received a request to reset your EconIntel password.
                  This link expires in 1 hour.
                </p>
                <a href="${resetLink}"
                   style="display:inline-block;background:#0ea5e9;color:#fff;
                          padding:0.75rem 1.5rem;border-radius:8px;text-decoration:none;
                          font-weight:600">
                  Reset password
                </a>
                <p style="color:#999;font-size:0.8rem;margin-top:2rem">
                  If you didn't request this, ignore this email — your account is safe.
                </p>
              </div>`,
          }),
        });
      } catch (emailErr) {
        // Email failure is non-fatal — token is already stored.
        // Log and continue so the user doesn't get a 500.
        console.warn('[auth] Reset email failed:', emailErr);
      }
    } else {
      // No API key configured — log the link for local dev/testing
      console.log('[auth] RESEND_API_KEY not set. Reset link:', resetLink);
    }

    return jsonResponse(
      { message: 'If this email exists, a reset link has been sent.' },
      200,
      allowedOrigin
    );
  } catch (err) {
    console.error('[auth] Reset password request error:', err);
    return jsonResponse({ error: 'Failed to process request' }, 500, allowedOrigin);
  }
}

// ============================================================================
// VERIFY RESET TOKEN & SET NEW PASSWORD
// ============================================================================

/**
 * POST /functions/auth/verify-reset
 * Validates reset token and updates password.
 * Body: { resetToken: string, newPassword: string }
 * Returns: { jwt: string, userId: string }
 */
async function handleVerifyReset(request, env, jwtSecret, allowedOrigin) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON' }, 400, allowedOrigin);
  }

  const { resetToken, newPassword } = body;

  if (!resetToken || !newPassword) {
    return jsonResponse({ error: 'Missing resetToken or newPassword' }, 400, allowedOrigin);
  }

  if (newPassword.length < 12 || newPassword.length > 128) {
    return jsonResponse({ error: 'Password must be 12-128 characters' }, 400, allowedOrigin);
  }

  try {
    // Look up token in KV
    const userId = await TOKENS.get(`reset:${resetToken}`);

    if (!userId) {
      return jsonResponse({ error: 'Invalid or expired reset token' }, 401, allowedOrigin);
    }

    // Get user from Supabase (REST API)
    const { data: users } = await supabaseRest('users', 'GET', `id=eq.${encodeURIComponent(userId)}`);
    const user = users?.[0];

    if (!user) {
      return jsonResponse({ error: 'User not found' }, 404, allowedOrigin);
    }

    // Hash new password
    const newHash = await hashPassword(newPassword);

    // Update password and bump token_version to invalidate all other sessions (REST API)
    const newVersion = (user.token_version || 1) + 1;
    const { data: updatedUsers } = await supabaseRest('users', 'PATCH', `id=eq.${encodeURIComponent(userId)}`, {
      password_hash: newHash,
      token_version: newVersion
    });

    const updatedUser = updatedUsers?.[0] || user;
    updatedUser.token_version = newVersion; // Ensure version is correct

    // Delete reset token from KV
    await TOKENS.delete(`reset:${resetToken}`);

    // Generate new access token (15 min), refresh token (30 days), and CSRF token (24h).
    // Matches the same auth contract as login/signup so the frontend can log the user
    // in automatically after a successful password reset.
    const jwt = await generateJWT(
      { userId: updatedUser.id, email: updatedUser.email, username: updatedUser.username, plan: updatedUser.plan, tv: updatedUser.token_version },
      jwtSecret,
      900
    );
    const refreshToken = generateId();
    await TOKENS.put(`refresh:${refreshToken}`, updatedUser.id, { expirationTtl: 2592000 });
    const csrfToken = generateId();
    await TOKENS.put(`csrf:${csrfToken}`, csrfToken, { expirationTtl: 86400 });

    // JWT goes in an HttpOnly cookie — NOT the response body — so it can't be
    // read by JavaScript even if there's an XSS. Previous code returned { jwt }
    // in the body which made it XSS-accessible.
    const resetHeaders = new Headers({
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': allowedOrigin,
      'Access-Control-Allow-Credentials': 'true',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    });
    resetHeaders.append('Set-Cookie', `access_token=${jwt}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=900`);
    resetHeaders.append('Set-Cookie', `refresh_token=${refreshToken}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`);
    resetHeaders.append('Set-Cookie', `csrf_token=${csrfToken}; Path=/; Secure; SameSite=Strict; Max-Age=86400`);
    return new Response(
      JSON.stringify({ userId: updatedUser.id, username: updatedUser.username, email: updatedUser.email, plan: updatedUser.plan, csrfToken, message: 'Password updated successfully' }),
      { status: 200, headers: resetHeaders }
    );
  } catch (err) {
    console.error('[auth] Verify reset error:', err);
    return jsonResponse({ error: 'Failed to reset password' }, 500, allowedOrigin);
  }
}

// ============================================================================
// VERIFY EMAIL
// ============================================================================

/**
 * POST /functions/auth/verify-email
 * Marks user's email as verified.
 * Body: { verificationToken: string }
 * Returns: { message: string }
 */
async function handleVerifyEmail(request, env, allowedOrigin) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON' }, 400, allowedOrigin);
  }

  const { verificationToken } = body;

  if (!verificationToken) {
    return jsonResponse({ error: 'Missing verificationToken' }, 400, allowedOrigin);
  }

  try {
    // Look up token in KV
    const userId = await TOKENS.get(`verify:${verificationToken}`);

    if (!userId) {
      return jsonResponse({ error: 'Invalid or expired verification link' }, 401, allowedOrigin);
    }

    // Update user in Supabase
    const { error: updateError } = await supabaseRest('users', 'PATCH', `id=eq.${encodeURIComponent(userId)}`, { email_verified_at: new Date().toISOString() });

    if (updateError) throw new Error(updateError);

    // Delete token from KV
    await TOKENS.delete(`verify:${verificationToken}`);

    return jsonResponse({ message: 'Email verified successfully' }, 200, allowedOrigin);
  } catch (err) {
    console.error('[auth] Verify email error:', err);
    return jsonResponse({ error: 'Failed to verify email' }, 500, allowedOrigin);
  }
}

// ============================================================================
// UTILITY: Check password against HaveIBeenPwned API (Phase 9)
// ============================================================================

// ============================================================================
// REFRESH TOKEN (Phase 6)
// ============================================================================

/**
 * POST /functions/auth/refresh
 * Validates refresh token from cookie and returns new access token.
 * Cookies: refresh_token
 * Returns: { access_token (in cookie), csrfToken }
 */
async function handleRefreshToken(request, env, jwtSecret, allowedOrigin) {
  const cookies = parseCookies(request);
  const refreshToken = cookies.refresh_token;

  if (!refreshToken) {
    return jsonResponse({ error: 'Missing refresh token' }, 401, allowedOrigin);
  }

  try {
    // Look up refresh token in KV
    const userId = await TOKENS.get(`refresh:${refreshToken}`);

    if (!userId) {
      return jsonResponse({ error: 'Invalid or expired refresh token' }, 401, allowedOrigin);
    }

    // Get user from Supabase to fetch token_version
    const { data: _refreshUsers, error: fetchError } = await supabaseRest('users', 'GET', `id=eq.${encodeURIComponent(userId)}&select=id,email,username,plan,token_version`);
    const user = _refreshUsers?.[0] || null;

    if (fetchError || !user) {
      return jsonResponse({ error: 'User not found' }, 401, allowedOrigin);
    }

    // Generate new access token (15 minutes)
    const newAccessToken = await generateJWT(
      { userId: user.id, email: user.email, username: user.username, plan: user.plan, tv: user.token_version },
      jwtSecret,
      900
    );

    // Generate new CSRF token
    const csrfToken = generateId();
    await TOKENS.put(`csrf:${csrfToken}`, csrfToken, { expirationTtl: 86400 });

    // Return new tokens + user data so the frontend can restore session state
    const responseBody = JSON.stringify({
      csrfToken,
      user: { id: user.id, email: user.email, username: user.username, plan: user.plan, name: user.username }
    });

    // Fix: Set-Cookie must be separate headers — joining with commas breaks cookie parsing
    const refreshHeaders = new Headers({
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': allowedOrigin,
      'Access-Control-Allow-Credentials': 'true',
    });
    refreshHeaders.append('Set-Cookie', `access_token=${newAccessToken}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=900`);
    refreshHeaders.append('Set-Cookie', `csrf_token=${csrfToken}; Path=/; Secure; SameSite=Strict; Max-Age=86400`);
    return new Response(responseBody, { status: 200, headers: refreshHeaders });
  } catch (err) {
    console.error('[auth] Refresh token error:', err);
    return jsonResponse({ error: 'Failed to refresh token' }, 500, allowedOrigin);
  }
}

// ============================================================================
// DISCORD OAUTH — "Continue with Discord" button
// ============================================================================

/**
 * GET /auth?action=oauth-discord
 *
 * One handler, two legs of the OAuth dance:
 *
 * Leg 1 (no ?code= param) — user clicked the Discord button:
 *   Generate a random `state` (anti-CSRF), stash it in KV for 10 minutes,
 *   and redirect the browser to Discord's consent screen.
 *
 * Leg 2 (?code= and ?state= present) — Discord sent the user back:
 *   Verify the state matches what WE issued (rejects forged callbacks),
 *   exchange the one-time code for an access token (server-side, secret
 *   never touches the browser), fetch the user's email from Discord,
 *   find-or-create the account, and set the same JWT cookies as a normal
 *   login. Then redirect to chat.html.
 *
 * Errors redirect to /index.html?oauth_error=<code> instead of returning
 * JSON — this is a browser navigation, so the user needs a page, not data.
 */
async function handleOAuthDiscord(request, env, jwtSecret, allowedOrigin) {
  // ALLOWED_ORIGIN can be comma-separated; the first entry is the canonical
  // site URL — used to build the redirect_uri and post-login destination
  const base = allowedOrigin.split(',')[0].trim();
  // Must match the redirect URI registered in the Discord developer portal
  // character-for-character, or Discord rejects with "invalid redirect_uri"
  const redirectUri = `${base}/auth?action=oauth-discord`;
  // Helper: send the user somewhere with a 302 (browser navigation)
  const redirect = (to) => new Response(null, { status: 302, headers: { 'Location': to } });

  if (!env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET) {
    console.error('[auth] Discord OAuth env vars not configured');
    return redirect(`${base}/index.html?oauth_error=not_configured`);
  }

  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  // ── LEG 1: kick off the flow ──
  if (!code) {
    // Discord can send back ?error=access_denied (user hit cancel) or
    // ?error=redirect_uri_mismatch (Cloud Console misconfiguration).
    // Without this check we'd loop back to Leg 1 forever and EdgeOne kills the function.
    const providerError = url.searchParams.get('error');
    if (providerError) {
      return redirect(`${base}/index.html?oauth_error=${providerError === 'access_denied' ? 'denied' : 'exchange_failed'}`);
    }
    const newState = generateId();
    // 10-minute window to complete the consent screen
    await TOKENS.put(`oauth:state:${newState}`, 'discord', { expirationTtl: 600 });
    const authorizeUrl =
      'https://discord.com/oauth2/authorize' +
      `?client_id=${env.DISCORD_CLIENT_ID}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      '&response_type=code' +
      '&scope=identify%20email' +   // identify = username; email = verified email
      `&state=${newState}`;
    return redirect(authorizeUrl);
  }

  // ── LEG 2: Discord called back ──
  try {
    // State check: this value only exists in KV if WE started the flow.
    // A missing/wrong state means the callback was forged or expired.
    const stateValid = state && await TOKENS.get(`oauth:state:${state}`);
    if (!stateValid) {
      return redirect(`${base}/index.html?oauth_error=bad_state`);
    }
    await TOKENS.delete(`oauth:state:${state}`); // single-use

    // Exchange the one-time code for an access token.
    // This happens server-to-server — the client secret never leaves here.
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.DISCORD_CLIENT_ID,
        client_secret: env.DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      }).toString(),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      console.error('[auth] Discord token exchange failed:', JSON.stringify(tokenData));
      return redirect(`${base}/index.html?oauth_error=exchange_failed`);
    }

    // Ask Discord who this user is
    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { 'Authorization': `Bearer ${tokenData.access_token}` },
    });
    const discordUser = await userRes.json();

    // We key accounts on email, so an unverified/missing email is a no-go —
    // otherwise someone could claim an email they don't own
    if (!discordUser.email || discordUser.verified !== true) {
      return redirect(`${base}/index.html?oauth_error=no_verified_email`);
    }
    const email = discordUser.email.toLowerCase().trim();

    // Find existing account by email, or create a new one
    const { data: existingUsers } = await supabaseRest('users', 'GET', `email=eq.${encodeURIComponent(email)}`);
    let user = existingUsers?.[0] || null;

    if (!user) {
      // Build a username from the Discord handle: keep only allowed chars
      let username = (discordUser.username || 'user')
        .replace(/[^a-zA-Z0-9_]/g, '')
        .slice(0, 20) || 'user';
      // If that username is taken, append part of a random id to make it unique
      const { data: clash } = await supabaseRest('users', 'GET', `username=eq.${encodeURIComponent(username)}&select=id`);
      if (clash?.length) username = `${username}_${generateId().slice(0, 4)}`;

      const now = new Date().toISOString();
      user = {
        id: generateId(),
        email,
        username,
        // OAuth accounts have no password. Hash a long random string so the
        // column is valid but no password can ever match it. If they want
        // password login later, they use the reset-password flow.
        password_hash: await hashPassword(generateId() + generateId()),
        plan: 'free',
        token_version: 1,
        created_at: now,
        email_verified_at: now, // Discord already verified this email
      };
      const { error: insertError } = await supabaseRest('users', 'POST', '', user);
      if (insertError) {
        console.error('[auth] Discord OAuth user insert failed:', insertError);
        return redirect(`${base}/index.html?oauth_error=signup_failed`);
      }
    } else {
      // Existing account — just record the login time (best-effort)
      await supabaseRest('users', 'PATCH', `id=eq.${encodeURIComponent(user.id)}`, { last_login_at: new Date().toISOString() });
    }

    // Issue the exact same session as a password login:
    // 15-min access JWT + 30-day refresh token + 24h CSRF token
    const jwt = await generateJWT(
      { userId: user.id, email: user.email, username: user.username, plan: user.plan, tv: user.token_version },
      jwtSecret,
      900
    );
    const refreshToken = generateId();
    await TOKENS.put(`refresh:${refreshToken}`, user.id, { expirationTtl: 2592000 });
    const csrfToken = generateId();
    await TOKENS.put(`csrf:${csrfToken}`, csrfToken, { expirationTtl: 86400 });

    // 302 to chat with the cookies attached. ?oauth=1 tells chat.html to call
    // the refresh endpoint on load, which returns the user data it needs for
    // localStorage (the cookies themselves are HttpOnly — JS can't read them).
    const oauthHeaders = new Headers({ 'Location': `${base}/chat.html?oauth=1` });
    oauthHeaders.append('Set-Cookie', `access_token=${jwt}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=900`);
    oauthHeaders.append('Set-Cookie', `refresh_token=${refreshToken}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`);
    oauthHeaders.append('Set-Cookie', `csrf_token=${csrfToken}; Path=/; Secure; SameSite=Strict; Max-Age=86400`);
    return new Response(null, { status: 302, headers: oauthHeaders });
  } catch (err) {
    console.error('[auth] Discord OAuth error:', err);
    return redirect(`${base}/index.html?oauth_error=server_error`);
  }
}

// ============================================================================
// GOOGLE OAUTH — "Continue with Google" button
// ============================================================================

/**
 * GET /auth?action=oauth-google
 *
 * Identical structure to handleOAuthDiscord — see the comments there for the
 * full explanation of the two-leg flow. Only the endpoints and the shape of
 * the user-info response differ:
 *   consent screen:  accounts.google.com/o/oauth2/v2/auth
 *   token exchange:  oauth2.googleapis.com/token
 *   user info:       openidconnect.googleapis.com/v1/userinfo
 */
async function handleOAuthGoogle(request, env, jwtSecret, allowedOrigin) {
  const base = allowedOrigin.split(',')[0].trim();
  // Must match the "Authorized redirect URI" in Google Cloud Console exactly
  const redirectUri = `${base}/auth?action=oauth-google`;
  const redirect = (to) => new Response(null, { status: 302, headers: { 'Location': to } });

  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    console.error('[auth] Google OAuth env vars not configured');
    return redirect(`${base}/index.html?oauth_error=not_configured`);
  }

  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  // ── LEG 1: send the user to Google's consent screen ──
  if (!code) {
    // Google sends ?error=access_denied or ?error=redirect_uri_mismatch on failure.
    // Without this check we loop straight back to Leg 1 infinitely.
    const providerError = url.searchParams.get('error');
    if (providerError) {
      return redirect(`${base}/index.html?oauth_error=${providerError === 'access_denied' ? 'denied' : 'exchange_failed'}`);
    }
    const newState = generateId();
    await TOKENS.put(`oauth:state:${newState}`, 'google', { expirationTtl: 600 });
    const authorizeUrl =
      'https://accounts.google.com/o/oauth2/v2/auth' +
      `?client_id=${env.GOOGLE_CLIENT_ID}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      '&response_type=code' +
      '&scope=openid%20email%20profile' +
      '&prompt=select_account' +    // always show the account picker
      `&state=${newState}`;
    return redirect(authorizeUrl);
  }

  // ── LEG 2: Google called back ──
  try {
    const stateValid = state && await TOKENS.get(`oauth:state:${state}`);
    if (!stateValid) {
      return redirect(`${base}/index.html?oauth_error=bad_state`);
    }
    await TOKENS.delete(`oauth:state:${state}`); // single-use

    // Exchange the one-time code for an access token (server-to-server)
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      }).toString(),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      console.error('[auth] Google token exchange failed:', JSON.stringify(tokenData));
      return redirect(`${base}/index.html?oauth_error=exchange_failed`);
    }

    // Who is this? Google returns { email, email_verified, name, given_name, ... }
    const userRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { 'Authorization': `Bearer ${tokenData.access_token}` },
    });
    const googleUser = await userRes.json();

    if (!googleUser.email || googleUser.email_verified !== true) {
      return redirect(`${base}/index.html?oauth_error=no_verified_email`);
    }
    const email = googleUser.email.toLowerCase().trim();

    // Find existing account by email, or create a new one
    const { data: existingUsers } = await supabaseRest('users', 'GET', `email=eq.${encodeURIComponent(email)}`);
    let user = existingUsers?.[0] || null;

    if (!user) {
      // Username from their Google name, falling back to the email local part
      let username = (googleUser.given_name || googleUser.name || email.split('@')[0])
        .replace(/[^a-zA-Z0-9_]/g, '')
        .slice(0, 20) || 'user';
      const { data: clash } = await supabaseRest('users', 'GET', `username=eq.${encodeURIComponent(username)}&select=id`);
      if (clash?.length) username = `${username}_${generateId().slice(0, 4)}`;

      const now = new Date().toISOString();
      user = {
        id: generateId(),
        email,
        username,
        // No password for OAuth accounts — random unusable hash (see Discord handler)
        password_hash: await hashPassword(generateId() + generateId()),
        plan: 'free',
        token_version: 1,
        created_at: now,
        email_verified_at: now, // Google already verified this email
      };
      const { error: insertError } = await supabaseRest('users', 'POST', '', user);
      if (insertError) {
        console.error('[auth] Google OAuth user insert failed:', insertError);
        return redirect(`${base}/index.html?oauth_error=signup_failed`);
      }
    } else {
      await supabaseRest('users', 'PATCH', `id=eq.${encodeURIComponent(user.id)}`, { last_login_at: new Date().toISOString() });
    }

    // Same session contract as password login: JWT + refresh + CSRF cookies
    const jwt = await generateJWT(
      { userId: user.id, email: user.email, username: user.username, plan: user.plan, tv: user.token_version },
      jwtSecret,
      900
    );
    const refreshToken = generateId();
    await TOKENS.put(`refresh:${refreshToken}`, user.id, { expirationTtl: 2592000 });
    const csrfToken = generateId();
    await TOKENS.put(`csrf:${csrfToken}`, csrfToken, { expirationTtl: 86400 });

    const oauthHeaders = new Headers({ 'Location': `${base}/chat.html?oauth=1` });
    oauthHeaders.append('Set-Cookie', `access_token=${jwt}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=900`);
    oauthHeaders.append('Set-Cookie', `refresh_token=${refreshToken}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`);
    oauthHeaders.append('Set-Cookie', `csrf_token=${csrfToken}; Path=/; Secure; SameSite=Strict; Max-Age=86400`);
    return new Response(null, { status: 302, headers: oauthHeaders });
  } catch (err) {
    console.error('[auth] Google OAuth error:', err);
    return redirect(`${base}/index.html?oauth_error=server_error`);
  }
}

// ============================================================================
// UTILITY: Check password against HaveIBeenPwned API (Phase 9)
// ============================================================================

/**
 * Check if password has been compromised in known breaches.
 * Uses k-anonymity: sends first 5 chars of SHA1 hash, receives list of suffix matches.
 * @param {string} password - Plain text password
 * @returns {Promise<boolean>} True if password found in breaches
 */
async function checkHaveIBeenPwned(password) {
  try {
    // SHA1 hash the password
    const encoder = new TextEncoder();
    const data = encoder.encode(password);
    const hashBuffer = await crypto.subtle.digest('SHA-1', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();

    // Send first 5 chars (k-anonymity)
    const prefix = hashHex.slice(0, 5);
    const suffix = hashHex.slice(5);

    const response = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
      method: 'GET',
      timeout: 5000, // 5 second timeout
    });

    if (!response.ok) {
      console.warn('[auth] HIBP API returned', response.status);
      return false; // Assume safe if API fails
    }

    const responseText = await response.text();
    // Response format: "SUFFIX:COUNT\n" per line
    const lines = responseText.split('\r\n');

    for (const line of lines) {
      const [responseSuffix] = line.split(':');
      if (responseSuffix === suffix) {
        return true; // Password found in breaches
      }
    }

    return false; // Password not found in breaches
  } catch (err) {
    console.warn('[auth] HaveIBeenPwned check error:', err);
    return false; // Assume safe if check fails
  }
}

// ============================================================================
// UTILITY: Extract Bearer token from Authorization header
// ============================================================================

function getBearerToken(request) {
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) {
    return null;
  }
  return auth.slice(7); // Remove "Bearer " prefix
}

/**
 * Parse cookies from request header.
 * @param {Request} request - HTTP request
 * @returns {object} Key-value pairs of cookies
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
 * Phase 6: Validate CSRF token from header against cookie.
 * @param {Request} request - HTTP request
 * @returns {boolean} True if CSRF token is valid
 */
// Now async: double-submit check (header === cookie) PLUS KV lookup to confirm
// the token was actually issued by this server — not just copied from a stolen cookie.
async function validateCSRFToken(request, tokens) {
  const csrfHeader = request.headers.get('X-CSRF-Token');
  const cookies = parseCookies(request);
  const csrfCookie = cookies.csrf_token;

  // Both header and cookie must exist and match (double-submit pattern)
  if (!csrfHeader || !csrfCookie || csrfHeader !== csrfCookie) return false;

  // KV check: token must have been issued by the server at login/refresh time
  const stored = await tokens.get(`csrf:${csrfHeader}`);
  return !!stored;
}
