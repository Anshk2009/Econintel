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
  isLegacyHash,
  generateJWT,
  verifyJWT,
  generateId,
  jsonResponse,
  corsPreflightResponse,
  makeSupabase,
  getToken,
  parseCookies,
  getClientIP, resolveSupabaseKey, corsOrigin, hashIP } from './middleware.js';

// Rate limiting thresholds
const RATE_LIMITS = {
  failedLogin: { max: 5, window: 900 },
  // Account-wide failures from ANY IP. Higher than the per-IP+email limit
  // because anyone can push this counter for any account — set too low it
  // becomes a cheap way to lock someone out. 30/hour still caps distributed
  // guessing at ~720 tries a day, against a 12-char minimum + HIBP check.
  failedLoginAccount: { max: 30, window: 3600 },
  loginAttempts: { max: 20, window: 3600 },
  signupAttempts: { max: 3, window: 3600 },
  resetAttempts: { max: 3, window: 3600 },
  // Per NETWORK (SEC-12): resetAttempts above is per email, and the email is
  // whatever the caller types — one client could walk a list of addresses.
  resetAttemptsIP: { max: 5, window: 3600 },
};


// What goes into a rate-limit KEY in place of an IP or an email (audit SEC-08).
// legal.html promises IPs are stored only as a SHA-256 hash; chat.js kept that
// promise and these keys did not (rl:login:email:<email>:<ip> and friends), so
// a dump of kv_store read as a list of who signed in from where. hashIP() is the
// same SHA-256 chat.js uses; the name it has here says what it is for.
// ponytail: unsalted — enough for the promise as written, not against someone
// who brute-forces the IPv4 space. Upgrade path: an HMAC with a server-held
// pepper (needs a new EdgeOne secret).
const piiKey = (value) => hashIP(String(value));

// Count THIS attempt and report whether it is over the limit (audit SEC-02).
//
// There used to be two helpers: checkRateLimit() read the counter at the top of
// a handler and incrementRateLimit() wrote count+1 further down. A burst fired
// in parallel all read the same count and all passed — 20 simultaneous password
// guesses all reached comparePassword past a "5 per IP" lockout. One atomic
// TOKENS.incr() (kv_incr, migration 0013; read-then-write fallback until it is
// applied) gives every request its own slot, so the check and the count can no
// longer disagree.
async function hitRateLimit(kv, key, maxAttempts, windowSeconds) {
  const n = await kv.incr(key, windowSeconds);
  return { limited: n > maxAttempts, retryAfter: windowSeconds };
}

// Issue a session for `user` ({ id, email, username, plan, token_version }):
//   - a 15-minute access JWT
//   - a 30-day opaque refresh token, stored with the user's token_version so a
//     password reset or logout-all kills it (C1)
//   - a 24-hour CSRF token, stored with the userId so it cannot authorise a
//     request for anyone else (M3)
// The three cookies are appended to `headers`; the CSRF token is returned
// because the page also needs it in the response body (double-submit header).
// Signup, login, password reset, refresh and both OAuth providers all come
// through here, so a session is identical whatever created it (audit QA-02 —
// these were six hand-written copies).
async function issueSession(user, jwtSecret, headers) {
  const jwt = await generateJWT(
    { userId: user.id, email: user.email, username: user.username, plan: user.plan, tv: user.token_version },
    jwtSecret,
    900
  );
  const refreshToken = generateId();
  await TOKENS.put(`refresh:${refreshToken}`, JSON.stringify({ userId: user.id, tv: user.token_version }), { expirationTtl: 2592000 });
  const csrfToken = generateId();
  await TOKENS.put(`csrf:${csrfToken}`, JSON.stringify({ userId: user.id }), { expirationTtl: 86400 });
  // Set-Cookie must be separate headers — joining with commas breaks parsing.
  headers.append('Set-Cookie', `access_token=${jwt}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=900`);
  headers.append('Set-Cookie', `refresh_token=${refreshToken}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`);
  headers.append('Set-Cookie', `csrf_token=${csrfToken}; Path=/; Secure; SameSite=Strict; Max-Age=86400`);
  return csrfToken;
}

// The three session cookies, expired — every path that ends a session sends
// exactly these (logout, logout without CSRF, delete-account). One copy, so the
// attributes cannot drift apart between them (audit QA-02).
function appendClearedSessionCookies(headers) {
  headers.append('Set-Cookie', 'access_token=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0');
  headers.append('Set-Cookie', 'refresh_token=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0');
  headers.append('Set-Cookie', 'csrf_token=; Path=/; Secure; SameSite=Strict; Max-Age=0');
  return headers;
}

// Hoisted to module scope so the top-level handler functions (handleSignup,
// handleLogin, …) can use them. They are (re)assigned at the top of onRequest,
// closing over env-derived Supabase config which is constant per deployment.
let supabaseRest, TOKENS, dbCheck;

export async function onRequest(context) {
  const { request, env } = context;

  // Fail loud if config missing
  // SECURITY (L2): a short/guessable HS256 secret lets an attacker brute-force it
  // offline and forge valid JWTs (full account takeover). Require >= 32 chars.
  if (!env.JWT_SECRET || env.JWT_SECRET.length < 32) throw new Error('JWT_SECRET missing or too short (need >= 32 chars)');
  if (!env.ALLOWED_ORIGIN) throw new Error('ALLOWED_ORIGIN not configured');
  if (!env.SUPABASE_URL) throw new Error('SUPABASE_URL not configured');
  // The secret key only (QA-03) — see resolveSupabaseKey() for why there is
  // no anon fallback any more.
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
    } else if (action === 'delete-account' && request.method === 'POST') {
      // POST, not DELETE: EdgeOne routes on the exact path and we dispatch on
      // ?action=, so the verb carries no routing meaning here — and POST is the
      // one method every client and proxy handles identically with a body-less
      // CSRF-protected request.
      return await handleDeleteAccount(request, env, JWT_SECRET, ALLOWED_ORIGIN);
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
      return await handleOAuth('discord', request, env, JWT_SECRET, ALLOWED_ORIGIN);
    } else if (action === 'oauth-google' && request.method === 'GET') {
      // Same two-leg redirect flow as Discord, but against Google's endpoints
      return await handleOAuth('google', request, env, JWT_SECRET, ALLOWED_ORIGIN);
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
  // Hashed, never raw, in the key (SEC-08) — see piiKey().
  const ipKey = `rl:signup:${await piiKey(getClientIP(request))}`;

  // IP-based signup rate limit: 3 new accounts per IP per hour.
  // Prevents mass account creation / spam without blocking legitimate users.
  // Counted HERE, before the expensive HIBP + Argon2 work, atomically (SEC-02).
  const ipLimit = await hitRateLimit(TOKENS, ipKey, RATE_LIMITS.signupAttempts.max, RATE_LIMITS.signupAttempts.window);
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
    // SECURITY (M1 — no timing enumeration): run the expensive work (HIBP lookup +
    // Argon2 hash) BEFORE the "does this account already exist?" check, so signing
    // up with an ALREADY-REGISTERED email takes the same time as a brand-new one.
    // The old order returned immediately for an existing account (skipping the
    // ~100ms hash), leaking registered-vs-unregistered by response time. Now both
    // paths do the same dominant work; only a NEW account does the final INSERT — a
    // much smaller residual delta than the hash, not worth masking with a dummy write.

    // Reject passwords found in known breaches (HaveIBeenPwned, k-anonymity).
    try {
      const isPwned = await checkHaveIBeenPwned(password);
      if (isPwned) {
        return jsonResponse({ error: 'Password has been compromised in known breaches. Please choose a different password.' }, 400, allowedOrigin);
      }
    } catch (err) {
      // Non-fatal — HIBP being unreachable must not block signup.
      console.warn('[auth] HaveIBeenPwned check failed:', err);
    }

    // Hash the password (Argon2id). Computed up front: it's needed for the insert
    // below AND it equalises response timing against the existing-account path.
    const passwordHash = await hashPassword(password);

    // Now check whether the email or username is already taken.
    const existingEmailRes = await supabaseRest('users', 'GET', `email=eq.${encodeURIComponent(normalizedEmail)}&select=id`);
    // SECURITY: eq. (exact match), not ilike. — the username regex allows '_' and
    // a raw ilike turns that into a PostgREST/SQL LIKE wildcard, letting an
    // attacker grind position-by-position to confirm which usernames already
    // exist (a boolean-oracle enumeration the eq. email check above doesn't have).
    const existingUsernameRes = await supabaseRest('users', 'GET', `username=eq.${encodeURIComponent(username)}&select=id`);
    const existingEmail = existingEmailRes.data?.[0];
    const existingUsername = existingUsernameRes.data?.[0];

    // Generic response — never reveal whether the account already existed.
    if (existingEmail || existingUsername) {
      return jsonResponse({ message: 'If account can be created, confirmation email will be sent.' }, 200, allowedOrigin);
    }

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
    // Fix: Set-Cookie must be separate headers — joining with commas breaks cookie parsing
    const signupHeaders = new Headers({
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': corsOrigin(allowedOrigin),
      'Access-Control-Allow-Methods': 'POST, OPTIONS, GET, DELETE, PUT',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-CSRF-Token',
      'Access-Control-Allow-Credentials': 'true',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    });
    // Same contract as login, so the frontend is signed in straight after
    // signup. New accounts start at token_version 1 (the insert above).
    const csrfToken = await issueSession(
      { id: userId, email: normalizedEmail, username, plan: 'free', token_version: 1 }, jwtSecret, signupHeaders);

    const responseBody = JSON.stringify({
      userId,
      username,
      email: normalizedEmail,
      plan: 'free',
      csrfToken,
    });
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
  // The HASH of the rate-limit bucket, never the raw IP (SEC-08) — see piiKey().
  const ipHash = await piiKey(getClientIP(request));
  const ipKey = `rl:login:ip:${ipHash}`;

  // Per-IP attempts, successful or not (20/hour). Counted atomically (SEC-02).
  const ipLimit = await hitRateLimit(TOKENS, ipKey, RATE_LIMITS.loginAttempts.max, RATE_LIMITS.loginAttempts.window);
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

  // SECURITY (SEC-04): check the lockouts BEFORE comparing the password.
  // These checks used to live only inside the wrong-password branch, so a locked
  // account still logged in the moment the attacker guessed right: the lock
  // changed the error message for wrong guesses and blocked nothing.
  //   emailKey   — this email from THIS IP (5 per 15 min): stops one attacker.
  //   accountKey — this email from ANY IP (30 per hour): stops an attacker who
  //                rotates IPs (trivial on IPv6) to dodge the per-IP keys.
  // Each ATTEMPT takes a slot before the password is compared (atomic, SEC-02),
  // so a parallel burst cannot reach comparePassword more than `max` times. A
  // successful login clears emailKey below, so a few typos do not linger.
  const emailHash = await piiKey(normalizedEmail);
  const emailKey = `rl:login:email:${emailHash}:${ipHash}`;
  const accountKey = `rl:login:account:${emailHash}`;
  const emailLimit = await hitRateLimit(TOKENS, emailKey, RATE_LIMITS.failedLogin.max, RATE_LIMITS.failedLogin.window);
  const accountLimit = await hitRateLimit(TOKENS, accountKey, RATE_LIMITS.failedLoginAccount.max, RATE_LIMITS.failedLoginAccount.window);
  if (emailLimit.limited || accountLimit.limited) {
    const retryAfter = emailLimit.limited ? emailLimit.retryAfter : accountLimit.retryAfter;
    return jsonResponse({ error: 'Account temporarily locked. Try again later.' }, 429, allowedOrigin, { 'Retry-After': String(retryAfter) });
  }

  try {
    // Find user by email (REST API)
    const { data: users, error: fetchError } = await supabaseRest('users', 'GET', `email=eq.${encodeURIComponent(normalizedEmail)}`);
    const user = users?.[0];

    if (fetchError) throw fetchError;

    // SECURITY (timing oracle): always run a password comparison, even when no
    // account matched. If we skipped the hash work for unknown emails, the
    // response would return measurably faster for non-existent accounts, letting
    // an attacker enumerate which emails are registered. Comparing against a
    // valid dummy hash (same Argon2id cost) keeps the timing uniform. The dummy
    // is a well-formed Argon2id PHC string that no real password matches, so the
    // no-account path runs the same memory-hard work as a real verification.
    const DUMMY_HASH = '$argon2id$v=19$m=19456,t=2,p=1$a9FcV0ds4b6CIRGHqB7lwg$RCHCM69x9qt6fWuVkW/M9ZE+t+9naWWqxaPboM2GYao';
    const passwordOK = await comparePassword(password, user ? user.password_hash : DUMMY_HASH);

    if (!user || !passwordOK) {
      // Increment failed login counter.
      // SECURITY (M2): scope the per-email failed-login lock to the client IP too.
      // A pure per-email lock let anyone lock ANY account out of logging in for
      // 15 min just by sending 5 bad passwords for that email (targeted DoS). The
      // per-IP counter (ipKey, 20/hr) still bounds a single attacker's total
      // guesses, while this IP+email key stops a remote attacker from locking out
      // a victim they aren't co-located with. ipHash is the trusted
      // EO-Connecting-IP value (see getClientIP / H1). This attempt was already
      // counted against every key above, BEFORE the password (SEC-04, SEC-02).
      return jsonResponse({ error: 'Invalid email or password' }, 401, allowedOrigin);
    }

    // Right password: forget this IP's failed attempts for this email, so a
    // user who typoed a few times is not one typo away from a lockout later.
    await TOKENS.delete(emailKey);

    // Update last login time (REST API - PATCH)
    const { error: updateError } = await supabaseRest('users', 'PATCH', `id=eq.${encodeURIComponent(user.id)}`, { last_login_at: new Date().toISOString() });

    if (updateError) console.warn('[auth] Failed to update login time:', updateError);

    // SECURITY (upgrade-on-login): if this account still carries a legacy
    // iterated-SHA-256 hash, transparently re-hash the password we JUST verified
    // with Argon2id and store it. This migrates old accounts to strong hashing
    // the next time they sign in. Best-effort only — wrapped in its own try/catch
    // so a re-hash failure can never block an otherwise-valid login.
    if (isLegacyHash(user.password_hash)) {
      try {
        const upgradedHash = await hashPassword(password);
        await supabaseRest('users', 'PATCH', `id=eq.${encodeURIComponent(user.id)}`, { password_hash: upgradedHash });
      } catch (err) {
        console.warn('[auth] Password rehash-on-login failed (non-fatal):', err);
      }
    }

    // Fix: Set-Cookie must be separate headers — joining with commas breaks cookie parsing
    const loginHeaders = new Headers({
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': corsOrigin(allowedOrigin),
      'Access-Control-Allow-Methods': 'POST, OPTIONS, GET, DELETE, PUT',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-CSRF-Token',
      'Access-Control-Allow-Credentials': 'true',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    });
    const csrfToken = await issueSession(user, jwtSecret, loginHeaders);

    const responseBody = JSON.stringify({
      userId: user.id,
      username: user.username,
      email: user.email,
      plan: user.plan,
      csrfToken, // Include CSRF token in response for client to verify
    });
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
  // Helper: headers that wipe all three auth cookies regardless of outcome below.
  // Defined early so we can reuse it on CSRF failure — logging someone out is
  // harmless, so clearing cookies even on a failed CSRF check is the right call.
  // Failing to clear means the HttpOnly refresh_token lingers for 30 days.
  function makeClearCookieHeaders() {
    const h = new Headers({
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': corsOrigin(allowedOrigin),
      'Access-Control-Allow-Credentials': 'true',
    });
    appendClearedSessionCookies(h);
    return h;
  }

  // SECURITY: revoke the server-side refresh token so logout actually ends the
  // session everywhere — not just in this browser. Clearing the cookie alone
  // only hides the token from the client; the 30-day refresh token stayed valid
  // in KV, so anyone who had captured it could keep minting new access tokens
  // after the user "logged out". We do this BEFORE the CSRF check so the token
  // is killed even on the cookie-expired path below (the session is dead either
  // way, and revoking is always the safe thing to do on a logout request).
  const refreshTokenToRevoke = parseCookies(request).refresh_token;
  if (refreshTokenToRevoke) {
    try {
      await TOKENS.delete(`refresh:${refreshTokenToRevoke}`);
    } catch (err) {
      console.warn('[auth] Failed to revoke refresh token on logout:', err);
    }
  }

  // Validate CSRF token (double-submit + KV server-issuance check).
  // CSRF cookie has a 24h TTL — if it expires before the user signs out, the
  // check fails and we used to return 403 without clearing cookies. Now we
  // clear cookies anyway (the session is dead either way) and return 200.
  if (!await validateCSRFToken(request, TOKENS)) {
    return new Response(JSON.stringify({ message: 'Logged out' }), { status: 200, headers: makeClearCookieHeaders() });
  }

  // SECURITY (M5): read the access token from the HttpOnly cookie when there's no
  // Authorization header. JS can't read that cookie, so the real client never
  // sends a Bearer header — meaning the old getBearerToken-only path returned 401
  // on every genuine logout and never reached the blacklist step below. With the
  // cookie fallback we can actually blacklist the access token so it dies before
  // its 15-minute expiry.
  let token = getToken(request);

  if (!token) {
    // Nothing to blacklist — but logout is idempotent. Clear cookies and succeed.
    return new Response(JSON.stringify({ message: 'Logged out' }), { status: 200, headers: makeClearCookieHeaders() });
  }

  // Verify token — includes token_version DB check to catch revoked sessions immediately
  const payload = await verifyJWT(token, jwtSecret, { TOKENS, dbCheck });
  if (!payload) {
    // An expired or revoked access token has nothing left to blacklist, and the
    // refresh token was already revoked above. This used to answer 401 WITHOUT
    // clearing cookies — after a password reset on another device, "Sign out"
    // here left every session cookie in the browser. Logout is idempotent.
    return new Response(JSON.stringify({ message: 'Logged out' }), { status: 200, headers: makeClearCookieHeaders() });
  }

  // Store token in blacklist (KV) until expiry (TTL in seconds, not minutes)
  const ttl = Math.ceil(payload.exp - Math.floor(Date.now() / 1000));
  if (ttl > 0) {
    try {
      await TOKENS.put(`blacklist:${payload.jti}`, '1', { expirationTtl: ttl });
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
    'Access-Control-Allow-Origin': corsOrigin(allowedOrigin),
    'Access-Control-Allow-Credentials': 'true',
  });
  appendClearedSessionCookies(logoutHeaders);
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
  // SECURITY (M5): read the access token from the cookie (JS can't read the
  // HttpOnly cookie to send a Bearer header).
  let token = getToken(request);

  if (!token) {
    return jsonResponse({ error: 'Missing token' }, 401, allowedOrigin);
  }

  // Verify the token FIRST so we know who is calling — needed to bind the CSRF
  // check to this user (M3). Includes the token_version DB check to catch already
  // revoked sessions immediately.
  const payload = await verifyJWT(token, jwtSecret, { TOKENS, dbCheck });
  if (!payload) {
    return jsonResponse({ error: 'Invalid or expired token' }, 401, allowedOrigin);
  }

  // Validate CSRF token (double-submit + KV server-issuance + bound to THIS user, M3)
  if (!await validateCSRFToken(request, TOKENS, payload.userId)) {
    return jsonResponse({ error: 'Invalid or missing CSRF token' }, 403, allowedOrigin);
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
        await TOKENS.put(`blacklist:${payload.jti}`, '1', { expirationTtl: ttl });
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
// DELETE ACCOUNT (right to erasure)
// ============================================================================

/**
 * POST /auth?action=delete-account
 *
 * WHY THIS EXISTS: the Privacy Policy and the Terms both promise the reader they
 * can delete their account, and until now nothing behind that promise existed —
 * the only real control was "delete chat history". Under the DPDP Act 2023
 * erasure is a statutory right, not a courtesy, so a published promise with no
 * mechanism is the gap, not the wording.
 *
 * ONE STATEMENT DOES ALL OF IT. chat_history declares
 * `user_id ... REFERENCES users(id) ON DELETE CASCADE`, so deleting the users
 * row takes every saved message with it in a single round trip — no per-table
 * cleanup to forget, and no way for a future table to be missed as long as it
 * declares the same cascade. (The legacy api_usage / email_tokens /
 * login_events tables were dropped on 2026-08-23 — see .migrations/0012 — so
 * chat_history is now the only child table there is.)
 *
 * SESSIONS DIE WITH THE ROW, FOR FREE. verifyJWT's dbCheck reads
 * users.token_version and compares it to the token's `tv`; with the row gone it
 * reads undefined, the comparison fails, and every outstanding access token is
 * rejected on its next use. handleRefreshToken looks the user up too and answers
 * 401 "User not found". So there is deliberately no token_version bump here —
 * it would be a write to a row we are about to delete.
 *
 * Headers: X-CSRF-Token (must match the cookie AND have been issued to this user)
 * Returns: 200 { message } with all three auth cookies cleared.
 */
async function handleDeleteAccount(request, env, jwtSecret, allowedOrigin) {
  // Authenticate FIRST so we know who is calling — needed to bind the CSRF check
  // to this user (M3), exactly like handleLogoutAll.
  const token = getToken(request);
  if (!token) {
    return jsonResponse({ error: 'Missing token' }, 401, allowedOrigin);
  }
  const payload = await verifyJWT(token, jwtSecret, { TOKENS, dbCheck });
  if (!payload) {
    return jsonResponse({ error: 'Invalid or expired token' }, 401, allowedOrigin);
  }

  // Deleting an account is the most destructive thing this API can do, so it
  // gets the strictest CSRF check available: double-submit, server-issuance, and
  // bound to THIS user.
  if (!await validateCSRFToken(request, TOKENS, payload.userId)) {
    return jsonResponse({ error: 'Invalid or missing CSRF token' }, 403, allowedOrigin);
  }

  const userId = payload.userId;

  try {
    // Revoke this browser's refresh token before the row goes. Refresh tokens
    // live in kv_store under a random key with no foreign key to users, so the
    // cascade cannot reach them; handleRefreshToken would reject it anyway once
    // the user is gone, but leaving a live-looking token in the store for 30
    // days after an erasure request is not what erasure should look like.
    const refreshToken = parseCookies(request).refresh_token;
    if (refreshToken) {
      try {
        await TOKENS.delete(`refresh:${refreshToken}`);
      } catch (err) {
        console.warn('[auth] Failed to revoke refresh token on account delete:', err);
      }
    }

    const { error: deleteError } = await supabaseRest('users', 'DELETE', `id=eq.${encodeURIComponent(userId)}`);
    if (deleteError) throw new Error(deleteError);

    // SECURITY (SEC-15): erase every kv_store row that still names this person.
    // The cascade only reaches chat_history; kv_store has no foreign key, so
    // their email sat on in rate-limit keys and their userId in chat counters
    // and in every OTHER device's refresh/CSRF rows. Rate-limit keys hold the
    // HASH of the email (SEC-08), so that is what is matched; anchored on ':' so
    // one hash can never match inside another key. Best-effort: the account
    // itself is already gone, so a failure here is logged, not returned.
    const like = (col, pattern) => `${col}=like.${encodeURIComponent(pattern)}`;
    const email = String(payload.email || '').toLowerCase();
    const cleanups = [
      like('key', `*${userId}*`),        // chat:rl:auth:{min,user}:<userId>:…
      like('value', `*${userId}*`),      // refresh:/csrf:/reset: rows owned by them
    ];
    if (email) {
      const emailHash = await piiKey(email);
      cleanups.push(like('key', `*:${emailHash}`), like('key', `*:${emailHash}:*`));
    }
    for (const filter of cleanups) {
      const { error } = await supabaseRest('kv_store', 'DELETE', filter);
      if (error) console.warn('[auth] kv_store cleanup after account delete failed:', error);
    }
  } catch (err) {
    console.error('[auth] Delete account error:', err);
    return jsonResponse({ error: 'Failed to delete account' }, 500, allowedOrigin);
  }

  // Clear all three cookies — the session they belong to no longer has an owner.
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': corsOrigin(allowedOrigin),
    'Access-Control-Allow-Credentials': 'true',
  });
  appendClearedSessionCookies(headers);
  return new Response(JSON.stringify({ message: 'Account deleted' }), { status: 200, headers });
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

  // Counted atomically up front, whether or not the account exists (SEC-02):
  // per network first (SEC-12 — the email is attacker-chosen), then per email.
  const ipLimit = await hitRateLimit(TOKENS, `rl:reset:ip:${await piiKey(getClientIP(request))}`, RATE_LIMITS.resetAttemptsIP.max, RATE_LIMITS.resetAttemptsIP.window);
  if (ipLimit.limited) {
    return jsonResponse({ error: 'Too many reset attempts. Try again later.' }, 429, allowedOrigin, { 'Retry-After': String(ipLimit.retryAfter) });
  }
  const emailKey = `rl:reset:${await piiKey(normalizedEmail)}`;
  const resetLimit = await hitRateLimit(TOKENS, emailKey, RATE_LIMITS.resetAttempts.max, RATE_LIMITS.resetAttempts.window);
  if (resetLimit.limited) {
    return jsonResponse({ error: 'Too many reset attempts. Try again later.' }, 429, allowedOrigin, { 'Retry-After': String(resetLimit.retryAfter) });
  }

  try {
    const { data: _resetUsers } = await supabaseRest('users', 'GET', `email=eq.${encodeURIComponent(normalizedEmail)}&select=id,email`);
    const user = _resetUsers?.[0] || null;

    // Generic response (no user enumeration)
    if (!user) {
      return jsonResponse({ message: 'If this email exists, a reset link has been sent.' }, 200, allowedOrigin);
    }

    // Generate reset token
    const resetToken = generateId();

    // Store token in KV (expires in 1 hour = 3600 seconds)
    // No IP binding — user may open the reset link on a different device/network
    await TOKENS.put(`reset:${resetToken}`, user.id, { expirationTtl: 3600 });

    // Send reset email via Resend (https://resend.com).
    // Requires RESEND_API_KEY in EdgeOne env vars.
    //
    // IMPORTANT — works for YOUR own inbox only, until you own a domain:
    // the test sender below (onboarding@resend.dev) can ONLY deliver to the
    // email of the Resend account owner. To email any real user, buy a domain,
    // verify it in the Resend dashboard, and change the `from` field to e.g.
    // EconIntel <noreply@yourdomain.com>. Until then, real users won't receive
    // the reset email (the request still succeeds; the token is stored).
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
      // SECURITY (L1): do NOT log the reset link — it contains a valid, usable
      // reset token that would then sit in EdgeOne's server logs. Just record that
      // the email wasn't sent; the token is in KV if you need it for local testing.
      console.log('[auth] RESEND_API_KEY not set — reset email NOT sent (token stored in KV).');
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

  if (typeof newPassword !== 'string' || newPassword.length < 12 || newPassword.length > 128) {
    return jsonResponse({ error: 'Password must be 12-128 characters' }, 400, allowedOrigin);
  }

  // SECURITY (SEC-12): same breached-password check as signup. Without it the
  // reset flow was a way to set a password signup would have refused. Checked
  // before the token is touched, so a refused password does not burn the link.
  // Fails open like signup (HIBP being down must not block a reset).
  try {
    if (await checkHaveIBeenPwned(newPassword)) {
      return jsonResponse({ error: 'Password has been compromised in known breaches. Please choose a different password.' }, 400, allowedOrigin);
    }
  } catch (err) {
    console.warn('[auth] HaveIBeenPwned check failed on reset:', err);
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
    // JWT goes in an HttpOnly cookie — NOT the response body — so it can't be
    // read by JavaScript even if there's an XSS. Previous code returned { jwt }
    // in the body which made it XSS-accessible.
    const resetHeaders = new Headers({
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': corsOrigin(allowedOrigin),
      'Access-Control-Allow-Credentials': 'true',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    });
    // Carries the NEW token_version (bumped above), so refresh tokens issued
    // before this reset are stale and rejected on their next use (C1).
    const csrfToken = await issueSession(updatedUser, jwtSecret, resetHeaders);
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
    // Look up refresh token in KV. New format = JSON { userId, tv }; legacy tokens
    // stored a bare userId string (handled by the parse fallback below).
    const storedRaw = await TOKENS.get(`refresh:${refreshToken}`);

    if (!storedRaw) {
      return jsonResponse({ error: 'Invalid or expired refresh token' }, 401, allowedOrigin);
    }

    // Parse the stored value, tolerating the legacy bare-string format.
    let storedUserId, storedTv = null;
    try {
      const parsed = JSON.parse(storedRaw);
      if (parsed && typeof parsed === 'object' && parsed.userId) {
        storedUserId = parsed.userId;
        storedTv = typeof parsed.tv === 'number' ? parsed.tv : null;
      } else {
        storedUserId = storedRaw; // legacy: the value WAS the userId
      }
    } catch {
      storedUserId = storedRaw; // legacy non-JSON value
    }

    // Get user from Supabase to fetch token_version
    const { data: _refreshUsers, error: fetchError } = await supabaseRest('users', 'GET', `id=eq.${encodeURIComponent(storedUserId)}&select=id,email,username,plan,token_version`);
    const user = _refreshUsers?.[0] || null;

    if (fetchError || !user) {
      return jsonResponse({ error: 'User not found' }, 401, allowedOrigin);
    }

    // SECURITY (C1): reject refresh tokens minted before a password reset /
    // logout-all. Those bump users.token_version; if the version stored with this
    // refresh token no longer matches, the session was revoked and the token must
    // die. Legacy tokens (storedTv === null) carry no version, so we revoke them
    // too — the user just signs in again, after which every new token is
    // version-bound. Without this, a stolen refresh token kept working for 30 days
    // even after the victim reset their password.
    if (storedTv === null || storedTv !== user.token_version) {
      await TOKENS.delete(`refresh:${refreshToken}`);
      return jsonResponse({ error: 'Session expired. Please sign in again.' }, 401, allowedOrigin);
    }

    // Generate new access token (15 minutes)
    // Fix: Set-Cookie must be separate headers — joining with commas breaks cookie parsing
    const refreshHeaders = new Headers({
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': corsOrigin(allowedOrigin),
      'Access-Control-Allow-Credentials': 'true',
    });
    // SECURITY (L4 — refresh-token rotation): issue a fresh session, THEN revoke
    // the refresh token just used, so a captured token works at most once.
    const csrfToken = await issueSession(user, jwtSecret, refreshHeaders);
    await TOKENS.delete(`refresh:${refreshToken}`);

    // Return new tokens + user data so the frontend can restore session state
    const responseBody = JSON.stringify({
      csrfToken,
      user: { id: user.id, email: user.email, username: user.username, plan: user.plan, name: user.username }
    });
    return new Response(responseBody, { status: 200, headers: refreshHeaders });
  } catch (err) {
    console.error('[auth] Refresh token error:', err);
    return jsonResponse({ error: 'Failed to refresh token' }, 500, allowedOrigin);
  }
}

// ============================================================================
// OAUTH ONTO AN EXISTING ACCOUNT — claim it if its email was never verified
// ============================================================================

/**
 * Called when an OAuth login matches an EXISTING users row by email.
 *
 * SECURITY (SEC-01, pre-account hijacking). Password signup never verifies the
 * email, so anyone can create an account for victim@gmail.com with a password
 * they choose. When the real owner later signs in with Google/Discord we used
 * to log them straight into that row — leaving the squatter holding a working
 * password to an account the victim now uses.
 *
 * The provider has verified the email, so the person signing in now is the
 * owner. If the row was never verified, the owner CLAIMS it:
 *   - password_hash -> an unguessable random hash (the squatter's password dies;
 *                      the owner can set one later via reset-password)
 *   - token_version -> +1 (every access + refresh token issued before now dies,
 *                      see verifyJWT's dbCheck and handleRefreshToken)
 *   - email_verified_at -> now (so the next OAuth login is an ordinary one)
 * A row that is ALREADY verified is left alone apart from last_login_at.
 *
 * Mutates `user` so the caller mints the session with the NEW token_version.
 */
async function claimOrTouchExistingUser(user) {
  const now = new Date().toISOString();
  if (user.email_verified_at) {
    await supabaseRest('users', 'PATCH', `id=eq.${encodeURIComponent(user.id)}`, { last_login_at: now });
    return;
  }
  const claimed = {
    password_hash: await hashPassword(generateId() + generateId()),
    token_version: (user.token_version || 1) + 1,
    email_verified_at: now,
    last_login_at: now,
  };
  const { error } = await supabaseRest('users', 'PATCH', `id=eq.${encodeURIComponent(user.id)}`, claimed);
  // If the claim did not save, the squatter's password is still live — refuse
  // to log the owner into that account rather than hand them a trap.
  if (error) throw new Error(`Failed to claim unverified account: ${error}`);
  Object.assign(user, claimed);
}

// ============================================================================
// OAUTH — "Continue with Google" / "Continue with Discord"
// ============================================================================

// What differs between the two providers. Everything else — state handling,
// token exchange, find-or-create, the claim of unverified rows, the session —
// is one code path below (audit QA-02: these were two ~140-line copies).
const OAUTH_PROVIDERS = {
  discord: {
    label: 'Discord',
    clientId: (env) => env.DISCORD_CLIENT_ID,
    clientSecret: (env) => env.DISCORD_CLIENT_SECRET,
    authorizeUrl: 'https://discord.com/oauth2/authorize',
    // identify = username; email = verified email
    authorizeParams: '&scope=identify%20email',
    tokenUrl: 'https://discord.com/api/oauth2/token',
    userinfoUrl: 'https://discord.com/api/users/@me',
    // We key accounts on email, so the provider must vouch for it.
    emailVerified: (u) => u.verified === true,
    usernameHint: (u) => u.username || 'user',
  },
  google: {
    label: 'Google',
    clientId: (env) => env.GOOGLE_CLIENT_ID,
    clientSecret: (env) => env.GOOGLE_CLIENT_SECRET,
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    // prompt=select_account: always show the account picker
    authorizeParams: '&scope=openid%20email%20profile&prompt=select_account',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    // Google returns { email, email_verified, name, given_name, ... }
    userinfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
    emailVerified: (u) => u.email_verified === true,
    usernameHint: (u, email) => u.given_name || u.name || email.split('@')[0],
  },
};

/**
 * GET /auth?action=oauth-<provider>
 *
 * One handler, two legs of the OAuth dance:
 *
 * Leg 1 (no ?code= param) — the user clicked the button:
 *   Generate a random `state` (anti-CSRF), stash it in KV for 10 minutes,
 *   and redirect the browser to the provider's consent screen.
 *
 * Leg 2 (?code= and ?state= present) — the provider sent the user back:
 *   Verify the state matches what WE issued (rejects forged callbacks),
 *   exchange the one-time code for an access token (server-side, secret
 *   never touches the browser), fetch the user's email, find-or-create the
 *   account, and set the same cookies as a normal login. Then go to chat.html.
 *
 * Errors redirect to /index.html?oauth_error=<code> instead of returning
 * JSON — this is a browser navigation, so the user needs a page, not data.
 */
async function handleOAuth(name, request, env, jwtSecret, allowedOrigin) {
  const p = OAUTH_PROVIDERS[name];
  // ALLOWED_ORIGIN can be comma-separated; the first entry is the canonical
  // site URL — used to build the redirect_uri and post-login destination
  const base = allowedOrigin.split(',')[0].trim();
  // Must match the redirect URI registered with the provider
  // character-for-character, or it rejects with "invalid redirect_uri"
  const redirectUri = `${base}/auth?action=oauth-${name}`;
  // Helper: send the user somewhere with a 302 (browser navigation)
  const redirect = (to) => new Response(null, { status: 302, headers: { 'Location': to } });
  const fail = (code) => redirect(`${base}/index.html?oauth_error=${code}`);

  if (!p.clientId(env) || !p.clientSecret(env)) {
    console.error(`[auth] ${p.label} OAuth env vars not configured`);
    return fail('not_configured');
  }

  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  // ── LEG 1: kick off the flow ──
  if (!code) {
    // The provider can send back ?error=access_denied (user hit cancel) or
    // ?error=redirect_uri_mismatch (console misconfiguration). Without this
    // check we'd loop back to Leg 1 forever and EdgeOne kills the function.
    const providerError = url.searchParams.get('error');
    if (providerError) return fail(providerError === 'access_denied' ? 'denied' : 'exchange_failed');

    const newState = generateId();
    // 10-minute window to complete the consent screen
    await TOKENS.put(`oauth:state:${newState}`, name, { expirationTtl: 600 });
    const authorizeUrl =
      p.authorizeUrl +
      `?client_id=${p.clientId(env)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      '&response_type=code' +
      p.authorizeParams +
      `&state=${newState}`;
    // SECURITY (M6): also pin the state to THIS browser via a short-lived cookie.
    // On callback we require this cookie to equal the ?state= param, so an attacker
    // can't pre-generate a callback URL and trick a victim into completing a login
    // into the ATTACKER's account (OAuth login-CSRF / session fixation). The KV
    // entry proves WE issued the state; the cookie proves it's the SAME browser.
    // SameSite=Lax (not Strict) so the cookie survives the top-level redirect back.
    const leg1Headers = new Headers({ 'Location': authorizeUrl });
    leg1Headers.append('Set-Cookie', `oauth_state=${newState}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
    return new Response(null, { status: 302, headers: leg1Headers });
  }

  // ── LEG 2: the provider called back ──
  try {
    // State check: the value must (a) exist in KV — proving WE started the flow —
    // AND (b) match the oauth_state cookie set on leg 1 — proving it's the SAME
    // browser that started it (M6, anti login-CSRF). A missing/wrong state means
    // the callback was forged, replayed in another browser, or expired.
    const cookieState = parseCookies(request).oauth_state;
    const stateValid = state && cookieState && state === cookieState && await TOKENS.get(`oauth:state:${state}`);
    if (!stateValid) return fail('bad_state');
    await TOKENS.delete(`oauth:state:${state}`); // single-use

    // Exchange the one-time code for an access token.
    // This happens server-to-server — the client secret never leaves here.
    const tokenRes = await fetch(p.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: p.clientId(env),
        client_secret: p.clientSecret(env),
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      }).toString(),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      // SECURITY (L1): log only the error string, never the full token payload.
      console.error(`[auth] ${p.label} token exchange failed:`, tokenData?.error || 'unknown error');
      return fail('exchange_failed');
    }

    // Ask the provider who this user is
    const userRes = await fetch(p.userinfoUrl, {
      headers: { 'Authorization': `Bearer ${tokenData.access_token}` },
    });
    const profile = await userRes.json();

    // We key accounts on email, so an unverified/missing email is a no-go —
    // otherwise someone could claim an email they don't own
    if (!profile.email || !p.emailVerified(profile)) return fail('no_verified_email');
    const email = profile.email.toLowerCase().trim();

    // Find existing account by email, or create a new one
    const { data: existingUsers } = await supabaseRest('users', 'GET', `email=eq.${encodeURIComponent(email)}`);
    let user = existingUsers?.[0] || null;

    if (!user) {
      // Username from the provider's name/handle: keep only allowed chars
      let username = String(p.usernameHint(profile, email))
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
        email_verified_at: now, // the provider already verified this email
      };
      const { error: insertError } = await supabaseRest('users', 'POST', '', user);
      if (insertError) {
        console.error(`[auth] ${p.label} OAuth user insert failed:`, insertError);
        return fail('signup_failed');
      }
    } else {
      // Existing account — claim it if its email was never verified (SEC-01),
      // otherwise just record the login time.
      await claimOrTouchExistingUser(user);
    }

    // Issue the exact same session as a password login, then 302 to chat.
    // ?oauth=1 tells chat.html to call the refresh endpoint on load, which
    // returns the user data it needs for localStorage (the cookies themselves
    // are HttpOnly — JS can't read them).
    const oauthHeaders = new Headers({ 'Location': `${base}/chat.html?oauth=1` });
    await issueSession(user, jwtSecret, oauthHeaders);
    // M6: the login is complete — clear the single-use OAuth state cookie.
    oauthHeaders.append('Set-Cookie', `oauth_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
    return new Response(null, { status: 302, headers: oauthHeaders });
  } catch (err) {
    console.error(`[auth] ${p.label} OAuth error:`, err);
    return fail('server_error');
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

    // The `timeout` option on fetch() is NOT part of the Web/EdgeOne fetch API —
    // it was silently ignored, so a slow HIBP response could hang signup. Use a
    // real AbortController so the request is actually cancelled after 5 seconds.
    const hibpController = new AbortController();
    const hibpTimer = setTimeout(() => hibpController.abort(), 5000);
    let response;
    try {
      response = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
        method: 'GET',
        signal: hibpController.signal,
      });
    } finally {
      clearTimeout(hibpTimer);
    }

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

// getBearerToken / getToken / parseCookies are imported from middleware.js.

/**
 * Phase 6: Validate CSRF token from header against cookie.
 * @param {Request} request - HTTP request
 * @returns {boolean} True if CSRF token is valid
 */
// Now async: double-submit check (header === cookie) PLUS KV lookup to confirm
// the token was actually issued by this server — not just copied from a stolen cookie.
async function validateCSRFToken(request, tokens, expectedUserId = null) {
  const csrfHeader = request.headers.get('X-CSRF-Token');
  const cookies = parseCookies(request);
  const csrfCookie = cookies.csrf_token;

  // Both header and cookie must exist and match (double-submit pattern)
  if (!csrfHeader || !csrfCookie || csrfHeader !== csrfCookie) return false;

  // KV check: token must have been issued by the server at login/refresh time
  const stored = await tokens.get(`csrf:${csrfHeader}`);
  if (!stored) return false;

  // SECURITY (M3): when the caller knows who is authenticated, require the CSRF
  // token to have been issued to THAT user. New tokens store { userId } as JSON;
  // legacy tokens stored the bare token string — for those we fall back to the
  // existence check above so sessions created before this change keep working
  // until they expire.
  if (expectedUserId !== null) {
    try {
      const parsed = JSON.parse(stored);
      if (parsed && typeof parsed === 'object' && 'userId' in parsed) {
        return parsed.userId === expectedUserId;
      }
    } catch { /* legacy non-JSON value — fall through to existence-only */ }
  }
  return true;
}
