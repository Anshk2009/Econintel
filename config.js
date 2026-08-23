/**
 * EconIntel Configuration
 *
 * Frontend and backend are served from the SAME EdgeOne origin, so every path
 * here is relative: no cross-origin requests and no CORS to configure.
 *
 * THERE USED TO BE A DEV BRANCH pointing at http://localhost:3000/functions.
 * Nothing in this repo has ever been able to serve functions/ on that port —
 * no wrangler, no dev script, no runner — so on localhost it produced requests
 * to a server that does not exist. Since the pages now carry a real CSP with
 * `connect-src 'self'`, that dead branch turned into a console full of CSP
 * violations the moment anyone served the folder statically, which reads as a
 * broken policy rather than a stale config line.
 *
 * Relative paths behave correctly in both places: in production they hit the
 * edge functions, and served locally they 404, which is the honest answer when
 * no backend is running. If a real local backend ever exists, add its origin
 * BOTH here and to connect-src in every page's CSP — they have to agree.
 */
const BASE = '';

const CONFIG = {
  // GA4 measurement ID ("G-XXXXXXXXXX"). Leave EMPTY to run no analytics at all.
  // consent.js only loads analytics after the visitor accepts AND this is set,
  // so an empty value means the site tracks nothing regardless of consent.
  analyticsId: '',

  // API Base URL (same origin in production)

  // Auth endpoints — EdgeOne routes exact paths only, so we dispatch via ?action=
  auth: {
    signup: `${BASE}/auth?action=signup`,
    login: `${BASE}/auth?action=login`,
    logout: `${BASE}/auth?action=logout`,
    // Right to erasure (DPDP Act 2023). POST + CSRF header; cascades the whole
    // account away and clears the session cookies in the same response.
    deleteAccount: `${BASE}/auth?action=delete-account`
  },

  // Chat endpoint
  chat: `${BASE}/chat`,

  // Chat history endpoints — dispatch via ?action=
  chatHistory: {
    get: `${BASE}/chat-history?action=get`,                     // flat history, or one thread with &conversation_id=
    conversations: `${BASE}/chat-history?action=conversations`, // grouped thread list for the sidebar
    delete: `${BASE}/chat-history?action=delete`,
    // Right of access (DPDP Act 2023). A plain GET the browser saves as a file —
    // linked directly, so no fetch/blob dance on the client.
    export: `${BASE}/chat-history?action=export`,
  },
};

// Expose globally so non-module scripts can access it
window.CONFIG = CONFIG;
