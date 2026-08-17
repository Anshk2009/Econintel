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

/**
 * Scroll progress bar — appended here rather than duplicated into every page.
 * Only added when the page is actually long enough to scroll meaningfully
 * (>1.6 screens), so short pages like 404 or the placeholders don't get a bar
 * that jumps straight to 100%. The blog post template has its own #progress
 * bar, so skip it there to avoid two bars stacked on top of each other.
 */
(function () {
  'use strict';
  function init() {
    if (document.getElementById('progress')) return;               // post template already has one
    var doc = document.documentElement;
    if (doc.scrollHeight < window.innerHeight * 1.6) return;        // not worth a bar

    var bar = document.createElement('div');
    bar.className = 'ei-progress';
    bar.setAttribute('aria-hidden', 'true');
    document.body.appendChild(bar);

    var ticking = false;
    function update() {
      var max = doc.scrollHeight - doc.clientHeight;
      bar.style.width = (max > 0 ? (doc.scrollTop / max) * 100 : 0) + '%';
      ticking = false;
    }
    addEventListener('scroll', function () {
      if (!ticking) { ticking = true; requestAnimationFrame(update); }
    }, { passive: true });
    addEventListener('resize', update, { passive: true });
    update();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

/**
 * UTM / referral attribution.
 *
 * Captures utm_* (and gclid/fbclid) from the landing URL and keeps them for the
 * session, so a signup or a chat visit can still be credited to the campaign
 * that produced it even after the visitor clicks through several pages — the
 * parameters only exist on the FIRST url, and are lost the moment they navigate.
 *
 * Stored in sessionStorage, not a cookie, and only FIRST-touch is kept (later
 * campaign params don't overwrite the original source). No personal data is
 * involved, and nothing is transmitted anywhere by this code — it just makes the
 * value available to whatever you wire up later (analytics event, signup field).
 * Read it with:  window.econintelAttribution.get()
 */
(function () {
  'use strict';
  var KEY = 'econintel:attribution';
  var FIELDS = ['utm_source','utm_medium','utm_campaign','utm_term','utm_content','gclid','fbclid','ref'];

  function read() {
    try { return JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch (e) { return null; }
  }

  function capture() {
    var params;
    try { params = new URLSearchParams(location.search); } catch (e) { return; }

    var found = {};
    FIELDS.forEach(function (f) {
      var v = params.get(f);
      // Cap length: these end up in analytics labels and should never carry a
      // payload. 200 chars is far more than any real campaign name.
      if (v) found[f] = String(v).slice(0, 200);
    });
    if (!Object.keys(found).length) return;

    // First touch wins — don't let a later campaign steal credit for the visit
    // that actually brought the person in.
    if (read()) return;

    found.landing_page = location.pathname;
    found.captured_at = new Date().toISOString();
    if (document.referrer) found.referrer = document.referrer.slice(0, 200);
    try { sessionStorage.setItem(KEY, JSON.stringify(found)); } catch (e) {}
  }

  window.econintelAttribution = {
    get: read,
    /** Flat object suitable for spreading into an analytics event. */
    params: function () { return read() || {}; },
    clear: function () { try { sessionStorage.removeItem(KEY); } catch (e) {} }
  };

  capture();
})();

/**
 * Copy buttons on <pre> code blocks (blog posts).
 * Uses the async clipboard API, which needs a secure context — falls back to
 * doing nothing visible rather than throwing on http://.
 */
(function () {
  'use strict';
  function init() {
    var blocks = document.querySelectorAll('pre');
    if (!blocks.length) return;

    blocks.forEach(function (pre) {
      if (pre.querySelector('.ei-copy')) return;
      pre.style.position = pre.style.position || 'relative';

      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ei-copy';
      btn.textContent = 'Copy';
      btn.setAttribute('aria-label', 'Copy code to clipboard');

      btn.addEventListener('click', function () {
        var code = pre.querySelector('code');
        var text = (code || pre).innerText;
        if (!navigator.clipboard) { btn.textContent = 'Unavailable'; return; }
        navigator.clipboard.writeText(text).then(function () {
          btn.textContent = 'Copied';
          btn.classList.add('is-done');
          setTimeout(function () { btn.textContent = 'Copy'; btn.classList.remove('is-done'); }, 1600);
        }, function () {
          btn.textContent = 'Failed';
          setTimeout(function () { btn.textContent = 'Copy'; }, 1600);
        });
      });

      pre.appendChild(btn);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

/**
 * ARTICLE → CHAT HANDOFF (blog pages only)
 *
 * Two behaviours, both routed through sessionStorage because the article text is
 * far too long for a query string and must survive a normal page navigation:
 *
 *  1. CONTEXT. Clicking "Ask a follow-up question" stashes the article so the
 *     terminal can answer about the piece the reader just finished. The terminal
 *     injects it as an INVISIBLE message — the model sees it, the reader does not
 *     see a wall of their own article pasted into the chat.
 *
 *  2. QUOTE. Selecting text raises a small "Quote" button. Using it carries the
 *     selection over and pre-fills the composer with it, visibly, so the reader
 *     can see exactly what they are asking about.
 *
 * Capped at ARTICLE_CHARS: functions/chat.js enforces a per-plan request body
 * limit (16 KB on free), and blowing that would fail the very first message.
 */
(function () {
  'use strict';
  var CTX_KEY   = 'econintel:articleContext';
  var QUOTE_KEY = 'econintel:pendingQuote';
  var ARTICLE_CHARS = 4000;
  var QUOTE_CHARS   = 600;

  var article = document.querySelector('article');
  if (!article) return;                       // not a post page

  /** Readable article text, minus the furniture a model gains nothing from. */
  function articleText() {
    var clone = article.cloneNode(true);
    clone.querySelectorAll('.post-footer, .disclaimer, .post-meta, .ei-copy, script').forEach(function (n) { n.remove(); });
    return clone.innerText.replace(/\n{3,}/g, '\n\n').trim().slice(0, ARTICLE_CHARS);
  }

  function stashContext() {
    var h1 = document.querySelector('h1');
    try {
      sessionStorage.setItem(CTX_KEY, JSON.stringify({
        title: h1 ? h1.textContent.trim() : document.title,
        url:   location.href,
        text:  articleText(),
        at:    Date.now()
      }));
    } catch (e) { /* private mode: chat just opens without context */ }
  }

  // 1 ── any link into the terminal carries the article with it.
  document.querySelectorAll('a[href*="chat.html"]').forEach(function (a) {
    a.addEventListener('click', stashContext);
  });

  // 2 ── selection -> Quote
  var btn = null;
  function hideBtn() { if (btn) { btn.remove(); btn = null; } }

  function showBtn(rect, text) {
    hideBtn();
    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ei-quote-btn';
    btn.textContent = 'Quote';
    btn.setAttribute('aria-label', 'Quote this passage in the terminal');
    // Position above the selection — but if the selection sits near the top of
    // the viewport, "above" is off-screen, so flip it below instead.
    var ABOVE = 44;
    var top;
    if (rect.top < ABOVE + 8) {
      top = rect.bottom + window.scrollY + 8;      // flip below
    } else {
      top = rect.top + window.scrollY - ABOVE;
    }
    var left = Math.min(
      Math.max(8, rect.left + window.scrollX + rect.width / 2 - 40),
      document.documentElement.clientWidth - 90
    );
    btn.style.top  = top + 'px';
    btn.style.left = left + 'px';

    btn.addEventListener('mousedown', function (e) { e.preventDefault(); }); // keep the selection
    btn.addEventListener('click', function () {
      stashContext();                                   // model still gets the whole piece
      try {
        sessionStorage.setItem(QUOTE_KEY, JSON.stringify({
          quote: text.slice(0, QUOTE_CHARS),
          title: (document.querySelector('h1') || {}).textContent || document.title,
          url: location.href
        }));
      } catch (e) {}
      hideBtn();
      location.href = new URL('../chat.html', location.href).pathname;
    });
    document.body.appendChild(btn);
  }

  function onSelect() {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed) { hideBtn(); return; }
    var text = sel.toString().trim();
    // Ignore stray clicks and accidental one-word drags.
    if (text.length < 12) { hideBtn(); return; }
    if (!article.contains(sel.anchorNode)) { hideBtn(); return; }
    var rect = sel.getRangeAt(0).getBoundingClientRect();
    if (!rect || !rect.width) { hideBtn(); return; }
    showBtn(rect, text);
  }

  document.addEventListener('mouseup', function () { setTimeout(onSelect, 10); });
  document.addEventListener('keyup', function (e) { if (e.shiftKey) setTimeout(onSelect, 10); });
  document.addEventListener('selectionchange', function () {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed) hideBtn();
  });
  addEventListener('scroll', hideBtn, { passive: true });
})();
