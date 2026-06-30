/**
 * EconIntel Configuration
 *
 * Frontend and backend are served from the SAME EdgeOne origin, so production
 * uses relative paths (no cross-origin requests, no CORS to configure).
 * - Development: points to local server (localhost:3000)
 * - Production: same-origin relative paths
 */

const isDev = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

// Production = same origin → empty base → relative paths like "/auth?action=signup"
const BASE = isDev ? 'http://localhost:3000/functions' : '';

const CONFIG = {
  // API Base URL (same origin in production)
  apiBase: isDev ? 'http://localhost:3000' : '',

  // Auth endpoints — EdgeOne routes exact paths only, so we dispatch via ?action=
  auth: {
    signup: `${BASE}/auth?action=signup`,
    login: `${BASE}/auth?action=login`,
    logout: `${BASE}/auth?action=logout`
  },

  // Chat endpoint
  chat: `${BASE}/chat`,

  // Chat history endpoints — dispatch via ?action=
  chatHistory: {
    get: `${BASE}/chat-history?action=get`,                     // flat history, or one thread with &conversation_id=
    conversations: `${BASE}/chat-history?action=conversations`, // grouped thread list for the sidebar
    delete: `${BASE}/chat-history?action=delete`,
  },
};

// Expose globally so non-module scripts can access it
window.CONFIG = CONFIG;
