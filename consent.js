/**
 * consent.js — cookie/analytics consent banner + consent-gated analytics loader.
 * Loaded by every page. No build step, no dependencies.
 *
 * ── WHY IT WORKS THIS WAY ────────────────────────────────────────────────────
 * India's DPDP Act 2023 and the GDPR both require FREELY GIVEN, INFORMED, PRIOR
 * consent before any non-essential tracking. Two consequences shape this file:
 *
 *  1. NOTHING analytics-related loads until the visitor actively accepts. The
 *     analytics script tag is never injected on a reject or on a first visit.
 *     A banner that loads trackers while it is still on screen is not consent.
 *
 *  2. Reject is exactly as easy and as prominent as Accept — one click, same
 *     visual weight. "Accept" styled as a button next to a buried text link is
 *     the specific dark pattern regulators have fined companies for.
 *
 * The choice itself is stored in localStorage, NOT a cookie. Storing a consent
 * cookie before the visitor has consented to anything is self-defeating; and
 * localStorage here is strictly necessary to honour the visitor's own choice,
 * which is the one thing that never needs consent.
 *
 * Global Privacy Control (navigator.globalPrivacyControl) is treated as a
 * legally binding opt-out signal, so we auto-reject and never show the banner.
 *
 * ── ANALYTICS IS DORMANT UNTIL CONFIGURED ────────────────────────────────────
 * Set window.CONFIG.analyticsId in config.js (a GA4 "G-XXXXXXX" measurement ID).
 * Until that exists, accepting stores the preference but loads nothing — there
 * is deliberately no fallback tracker. Nothing here phones home on its own.
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'econintel:consent';   // 'granted' | 'denied'
  var cfg = (window.CONFIG || {});
  var analyticsId = cfg.analyticsId || '';

  function stored() {
    try { return localStorage.getItem(STORAGE_KEY); } catch (e) { return null; }
  }
  function save(value) {
    try { localStorage.setItem(STORAGE_KEY, value); } catch (e) { /* private mode */ }
  }

  /** Inject GA4 only after consent. No-op when no measurement ID is configured. */
  function loadAnalytics() {
    if (!analyticsId || window.__econintelAnalyticsLoaded) return;
    window.__econintelAnalyticsLoaded = true;

    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(analyticsId);
    document.head.appendChild(s);

    window.dataLayer = window.dataLayer || [];
    function gtag() { window.dataLayer.push(arguments); }
    window.gtag = gtag;
    gtag('js', new Date());
    // anonymize_ip: truncates the IP before storage.
    // ad_storage/ad_user_data/ad_personalization denied: we run no advertising
    // and have no lawful basis to feed an ad profile.
    gtag('consent', 'default', {
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
      analytics_storage: 'granted'
    });
    gtag('config', analyticsId, { anonymize_ip: true });
  }

  /** Public API so other scripts (and the legal page) can react or re-prompt. */
  window.econintelConsent = {
    get: function () { return stored(); },
    accept: function () { save('granted'); hide(); loadAnalytics(); },
    reject: function () { save('denied'); hide(); },
    /** Let a visitor change their mind — linked from the Cookie Policy. */
    reopen: function () { try { localStorage.removeItem(STORAGE_KEY); } catch (e) {} show(); }
  };

  var el = null, lastFocus = null;

  function hide() {
    if (!el) return;
    el.remove(); el = null;
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  function show() {
    if (el) return;
    lastFocus = document.activeElement;

    el = document.createElement('div');
    el.className = 'ei-consent';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'false');       // non-blocking: the site stays usable
    el.setAttribute('aria-labelledby', 'ei-consent-title');
    el.innerHTML =
      '<div class="ei-consent-inner">' +
        '<div class="ei-consent-text">' +
          '<strong id="ei-consent-title">Analytics cookies</strong>' +
          'We use only what the site needs to sign you in. May we also measure ' +
          'anonymous page views to see what people read? You can change this any ' +
          'time. <a href="' + (el.baseURI.indexOf('/blog/') > -1 ? '../' : '') + 'legal.html#cookies">Cookie Policy</a>' +
        '</div>' +
        '<div class="ei-consent-actions">' +
          '<button type="button" class="ei-btn ei-btn-ghost" data-act="reject">Reject</button>' +
          '<button type="button" class="ei-btn ei-btn-solid" data-act="accept">Accept</button>' +
        '</div>' +
      '</div>';

    el.addEventListener('click', function (e) {
      var act = e.target && e.target.getAttribute && e.target.getAttribute('data-act');
      if (act === 'accept') window.econintelConsent.accept();
      if (act === 'reject') window.econintelConsent.reject();
    });
    // Escape = reject (declining must never be harder than accepting).
    el.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') window.econintelConsent.reject();
    });

    document.body.appendChild(el);
    var first = el.querySelector('.ei-btn');
    if (first) first.focus();
  }

  function init() {
    // GPC is a legally recognised opt-out in several jurisdictions: honour it
    // silently rather than asking a question the visitor has already answered.
    if (navigator.globalPrivacyControl === true) { save('denied'); return; }

    var choice = stored();
    if (choice === 'granted') { loadAnalytics(); return; }
    if (choice === 'denied') return;
    show();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
