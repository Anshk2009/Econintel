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
  const supabaseKey = env.SUPABASE_ANON_KEY;

  // REST API helper function
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
      if (!res.ok && res.status !== 409) {
        console.warn(`[supabase] ${method} ${table} failed:`, res.status, await res.text());
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

  // Validate Origin header (CORS hardening)
  const origin = request.headers.get('Origin');
  const allowedOrigins = ALLOWED_ORIGIN.split(',').map(o => o.trim());
  const validOrigin = origin && allowedOrigins.includes(origin) ? origin : null;

  // CORS preflight
  if (request.method === 'OPTIONS') {
    return corsPreflightResponse(ALLOWED_ORIGIN);
  }

  // Route requests based on URL path
  const url = new URL(request.url);
  const path = url.pathname;

  try {
    if (path === '/functions/auth/signup' && request.method === 'POST') {
      return await handleSignup(request, env, JWT_SECRET, ALLOWED_ORIGIN);
    } else if (path === '/functions/auth/login' && request.method === 'POST') {
      return await handleLogin(request, env, JWT_SECRET, ALLOWED_ORIGIN);
    } else if (path === '/functions/auth/logout' && request.method === 'POST') {
      return await handleLogout(request, env, JWT_SECRET, ALLOWED_ORIGIN);
    } else if (path === '/functions/auth/logout-all' && request.method === 'POST') {
      return await handleLogoutAll(request, env, JWT_SECRET, ALLOWED_ORIGIN);
    } else if (path === '/functions/auth/reset-password' && request.method === 'POST') {
      return await handleResetPasswordRequest(request, env, ALLOWED_ORIGIN);
    } else if (path === '/functions/auth/verify-reset' && request.method === 'POST') {
      return await handleVerifyReset(request, env, JWT_SECRET, ALLOWED_ORIGIN);
    } else if (path === '/functions/auth/verify-email' && request.method === 'POST') {
      return await handleVerifyEmail(request, env, ALLOWED_ORIGIN);
    } else if (path === '/functions/auth/refresh' && request.method === 'POST') {
      return await handleRefreshToken(request, env, JWT_SECRET, ALLOWED_ORIGIN);
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

  // Check IP-based rate limit
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

  const userId = generateId();

  try {
    // Check if email or username already exists (REST API)
    const existingEmailRes = await supabaseRest('users', 'GET', `email=eq.${encodeURIComponent(normalizedEmail)}&select=id`);
    const existingUsernameRes = await supabaseRest('users', 'GET', `username=ilike.${encodeURIComponent(username)}&select=id`);

    const existingEmail = existingEmailRes.data?.[0];
    const existingUsername = existingUsernameRes.data?.[0];

    // Increment counter regardless of result (rate limiting)
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

    // Generate JWT with token_version
    const jwt = await generateJWT({ userId, email: normalizedEmail, username, tv: 1 }, jwtSecret);

    return jsonResponse({ userId, jwt, message: 'Account created' }, 201, allowedOrigin);
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

    return new Response(responseBody, {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': allowedOrigin,
        'Access-Control-Allow-Methods': 'POST, OPTIONS, GET, DELETE, PUT',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-CSRF-Token',
        'Access-Control-Allow-Credentials': 'true',
        'Set-Cookie': [
          `access_token=${jwt}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=900`,
          `refresh_token=${refreshToken}; Path=/functions/auth/refresh; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`,
          `csrf_token=${csrfToken}; Path=/; Secure; SameSite=Strict; Max-Age=86400`,
        ].join(', '),
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
      },
    });
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
  // Phase 6: Validate CSRF token
  if (!validateCSRFToken(request)) {
    return jsonResponse({ error: 'Invalid or missing CSRF token' }, 403, allowedOrigin);
  }

  const token = getBearerToken(request);

  if (!token) {
    return jsonResponse({ error: 'Missing token' }, 401, allowedOrigin);
  }

  // Verify token is valid
  const payload = await verifyJWT(token, jwtSecret, { supabase, env });
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

  return new Response(responseBody, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': allowedOrigin,
      'Access-Control-Allow-Credentials': 'true',
      'Set-Cookie': [
        'access_token=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0',
        'refresh_token=; Path=/functions/auth/refresh; HttpOnly; Secure; SameSite=Strict; Max-Age=0',
        'csrf_token=; Path=/; Secure; SameSite=Strict; Max-Age=0',
      ].join(', '),
    },
  });
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
  // Phase 6: Validate CSRF token
  if (!validateCSRFToken(request)) {
    return jsonResponse({ error: 'Invalid or missing CSRF token' }, 403, allowedOrigin);
  }

  const token = getBearerToken(request);

  if (!token) {
    return jsonResponse({ error: 'Missing token' }, 401, allowedOrigin);
  }

  // Verify token is valid
  const payload = await verifyJWT(token, jwtSecret, { TOKENS });
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
    const { data: user } = await supabase
      .from('users')
      .select('id, email')
      .eq('email', normalizedEmail)
      .maybeSingle();

    // Increment counter regardless
    await incrementRateLimit(TOKENS, emailKey, RATE_LIMITS.resetAttempts.window);

    // Generic response (no user enumeration)
    if (!user) {
      return jsonResponse({ message: 'If this email exists, a reset link has been sent.' }, 200, allowedOrigin);
    }

    // Generate reset token
    const resetToken = generateId();
    const ipHash = await hashIP(clientIP);

    // Store token in KV (expires in 1 hour = 3600 seconds) with IP binding
    await TOKENS.put(`reset:${resetToken}:${ipHash}`, user.id, { expirationTtl: 3600 });

    // TODO: Wire real SMTP email sending with reset link containing token
    // For now: email delivery not configured; token discarded
    // Production: send email with: https://yourdomain.com/reset?token=<resetToken>

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

    // Generate new JWT with new token_version
    const jwt = await generateJWT(
      { userId: updatedUser.id, email: updatedUser.email, username: updatedUser.username, plan: updatedUser.plan, tv: updatedUser.token_version },
      jwtSecret
    );

    return jsonResponse(
      { jwt, userId: user.id, message: 'Password updated successfully' },
      200,
      allowedOrigin
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
    const { error: updateError } = await supabase
      .from('users')
      .update({ email_verified_at: new Date().toISOString() })
      .eq('id', userId);

    if (updateError) throw updateError;

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
    const { data: user, error: fetchError } = await supabase
      .from('users')
      .select('id, email, username, plan, token_version')
      .eq('id', userId)
      .single();

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

    // Return new tokens in response
    const responseBody = JSON.stringify({ csrfToken });

    return new Response(responseBody, {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': allowedOrigin,
        'Access-Control-Allow-Credentials': 'true',
        'Set-Cookie': [
          `access_token=${newAccessToken}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=900`,
          `csrf_token=${csrfToken}; Path=/; Secure; SameSite=Strict; Max-Age=86400`,
        ].join(', '),
      },
    });
  } catch (err) {
    console.error('[auth] Refresh token error:', err);
    return jsonResponse({ error: 'Failed to refresh token' }, 500, allowedOrigin);
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
function validateCSRFToken(request) {
  const csrfHeader = request.headers.get('X-CSRF-Token');
  const cookies = parseCookies(request);
  const csrfCookie = cookies.csrf_token;

  // Both header and cookie must exist and match
  return csrfHeader && csrfCookie && csrfHeader === csrfCookie;
}
