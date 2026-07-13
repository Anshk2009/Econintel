// EdgeOne Pages middleware — runs for EVERY request (static pages + function
// routes) and injects the security response headers that a <meta> tag CANNOT set.
//
// WHY THIS EXISTS: a `_headers` file is NOT honoured by EdgeOne Pages (it gets
// served back as a raw downloadable file), and <meta http-equiv="CSP"> is ignored
// by browsers for frame-ancestors / X-Frame-Options / HSTS. The only reliable
// place to set those on the static HTML is here, in a Pages middleware that wraps
// the response. chat.html holds an authenticated session, so it must never be
// framable (clickjacking) and must be HSTS-pinned.
//
// SCOPE: we ONLY touch text/html responses. The JSON/SSE API responses from
// auth.js / chat.js / chat-history.js already set their own security + CORS
// headers (see functions/middleware.js jsonResponse) and chat.js streams its
// body — re-wrapping those could disturb streaming or double-set CORS, so we
// pass everything that isn't HTML straight through untouched.
export async function onRequest(context) {
  const response = await context.next();

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/html')) {
    return response; // API / JSON / SSE / images / fonts — leave as-is
  }

  // Clone so we can mutate headers (the original headers may be immutable).
  const r = new Response(response.body, response);
  r.headers.set('X-Frame-Options', 'DENY');
  // frame-ancestors is the modern clickjacking guard; the other directives mirror
  // the page <meta> CSP so the policy is uniform even on pages without the meta.
  r.headers.set('Content-Security-Policy', "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
  // 2-year HSTS + includeSubDomains — matches what functions/middleware.js already
  // sends on API responses. EdgeOne manages the *.edgeone.app TLS cert, so there is
  // no founder-controlled cert that could expire and trip the pin.
  r.headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  r.headers.set('X-Content-Type-Options', 'nosniff');
  r.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  r.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  return r;
}
