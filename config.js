/**
 * EconIntel Configuration
 *
 * Handles environment-specific settings:
 * - Development: points to local server (localhost:3000)
 * - Production: points to EdgeOne (econintel.edgeone.app)
 */

const isDev = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

const BASE = isDev ? 'http://localhost:3000/functions' : 'https://econintel.edgeone.app';

const CONFIG = {
  // API Base URL
  apiBase: isDev ? 'http://localhost:3000' : 'https://econintel.edgeone.app',

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
    get: `${BASE}/chat-history?action=get`,
    delete: `${BASE}/chat-history?action=delete`,
  },

  // Debug mode
  debug: isDev,

  // Log environment
  log: () => {
    console.log(`%cEconIntel Configuration`, 'color: #0ea5e9; font-weight: bold');
    console.log(`Environment: ${isDev ? 'Development (Local)' : 'Production (EdgeOne)'}`);
    console.log(`API Base: ${CONFIG.apiBase}`);
  }
};

// Expose globally so non-module scripts can access it
window.CONFIG = CONFIG;

// Log on load
if (CONFIG.debug) {
  CONFIG.log();
}
