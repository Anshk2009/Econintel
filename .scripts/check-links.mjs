// scripts/check-links.mjs — crawl every page and verify every link.
//
// Checks, across all HTML pages:
//   • internal page links resolve (200)
//   • in-page anchors (#id) actually exist on the target page
//   • external links resolve (dead outbound links look sloppy and leak trust)
//   • assets referenced (scripts, styles, images) load
//
// Run:  node scripts/check-links.mjs            (against production)
//       BASE_URL=http://localhost:5180 node scripts/check-links.mjs
//
// Exit 1 if any INTERNAL link or anchor is broken. External failures are
// reported but do not fail the run by default (outlets rate-limit bots and
// block CI IPs; a 403 from a news site is not our bug) — set
// STRICT_EXTERNAL=1 to fail on those too.
import process from 'node:process';

const BASE = (process.env.BASE_URL || 'https://econintel.edgeone.app').replace(/\/$/, '');
const STRICT_EXTERNAL = process.env.STRICT_EXTERNAL === '1';

const PAGES = ['/', '/chat.html', '/legal.html', '/blogs.html', '/newsletter.html', '/reset-password.html', '/404.html', '/blog/upi-who-pays.html'];

// Browser UA: several sites 403 anything that looks automated.
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' };

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(url, opts = {}, ms = 25000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, headers: { ...UA, ...(opts.headers || {}) }, signal: ctrl.signal, redirect: 'follow' }); }
  finally { clearTimeout(t); }
}

const pageHtml = new Map();   // path -> { status, html (markup only) }
const pageIds  = new Map();   // path -> Set of ids/names

// "/index.html" and "/" are the same page. Without this, every anchor written as
// index.html#pricing looks like it points at an uncrawled page.
const canon = (p) => (p === '/index.html' ? '/' : p);

// Inline <script> and <style> contain things that LOOK like links but aren't —
// JS template literals such as src="${opts.imageDataUrl}" and CSS url(...).
// Strip them before extracting, or the checker reports its own noise as bugs.
const stripCode = (html) =>
  html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');

async function loadPages() {
  for (const p of PAGES) {
    const r = await get(BASE + p);
    const raw = await r.text();
    // ids are collected from the RAW html: an id can legitimately be inside a
    // template that the browser will render (e.g. modal markup built in JS).
    const ids = new Set();
    for (const m of raw.matchAll(/\sid=["']([^"']+)["']/g)) ids.add(m[1]);
    for (const m of raw.matchAll(/\sname=["']([^"']+)["']/g)) ids.add(m[1]);
    pageIds.set(canon(p), ids);
    pageHtml.set(canon(p), { status: r.status, html: stripCode(raw) });
  }
}

// Normalise an href found on `fromPage` into something checkable.
function classify(href, fromPage) {
  if (!href) return null;
  const h = href.trim();
  if (!h || h === '#') return null;
  if (/^(mailto:|tel:|javascript:|data:)/i.test(h)) return null;
  if (/^https?:\/\//i.test(h)) {
    return h.startsWith(BASE) ? { kind: 'internal', path: canon(h.slice(BASE.length) || '/') } : { kind: 'external', url: h };
  }
  if (h.startsWith('#')) return { kind: 'anchor', page: fromPage, id: h.slice(1) };
  if (h.startsWith('//')) return { kind: 'external', url: 'https:' + h };
  // Relative href. Resolve it with the URL parser rather than string-prefixing a
  // slash — a page in /blog/ links to "../legal.html", which naive concatenation
  // turns into "/../legal.html" and reports as a broken link that works fine in
  // any browser.
  const [pathPart, hash] = h.split('#');
  let path;
  try {
    path = new URL(pathPart || fromPage, 'http://x' + fromPage).pathname;
  } catch {
    path = pathPart && pathPart.startsWith('/') ? pathPart : '/' + (pathPart || '');
  }
  return hash ? { kind: 'anchor', page: canon(path), id: hash } : { kind: 'internal', path: canon(path) };
}

const results = { internal: [], anchor: [], external: [], asset: [] };
const seenExternal = new Map();

async function checkExternal(url) {
  if (seenExternal.has(url)) return seenExternal.get(url);
  let out;
  try {
    let r = await get(url, { method: 'HEAD' }, 20000);
    if ([403, 405, 501, 400].includes(r.status)) r = await get(url, {}, 20000);  // many hosts refuse HEAD from bots
    out = r.ok ? null : `HTTP ${r.status}`;
  } catch (e) { out = e.message.slice(0, 50); }
  seenExternal.set(url, out);
  await sleep(120);            // be polite
  return out;
}

console.log(`Crawling ${BASE}\n`);
await loadPages();

// Report any page that didn't serve
for (const [p, { status }] of pageHtml) {
  const expected = p === '/404.html' ? 200 : 200;
  if (status !== expected) results.internal.push(`${p} → HTTP ${status}`);
}

for (const [page, { html }] of pageHtml) {
  const hrefs = [...html.matchAll(/<a\b[^>]*\shref=["']([^"']+)["']/gi)].map(m => m[1]);
  const assets = [
    ...[...html.matchAll(/<script\b[^>]*\ssrc=["']([^"']+)["']/gi)].map(m => m[1]),
    // Only <link>s that fetch a real resource. preconnect/dns-prefetch point at
    // a bare ORIGIN with no path — requesting it 404s by design and means nothing.
    // canonical/alternate are metadata, not assets.
    ...[...html.matchAll(/<link\b[^>]*>/gi)]
      .filter(t => !/rel=["'][^"']*(preconnect|dns-prefetch|preload|canonical|alternate)/i.test(t[0]))
      .map(t => (t[0].match(/\shref=["']([^"']+)["']/i) || [])[1])
      .filter(Boolean),
    ...[...html.matchAll(/<img\b[^>]*\ssrc=["']([^"']+)["']/gi)].map(m => m[1]),
  ];

  for (const href of new Set(hrefs)) {
    const c = classify(href, page);
    if (!c) continue;
    if (c.kind === 'internal') {
      if (!pageHtml.has(c.path)) {
        const r = await get(BASE + c.path);
        if (!r.ok) results.internal.push(`${page} → ${href} (HTTP ${r.status})`);
      } else if (pageHtml.get(c.path).status !== 200) {
        results.internal.push(`${page} → ${href} (HTTP ${pageHtml.get(c.path).status})`);
      }
    } else if (c.kind === 'anchor') {
      if (!pageIds.has(c.page)) {
        results.anchor.push(`${page} → ${href} (target page not crawled)`);
      } else if (!pageIds.get(c.page).has(c.id)) {
        results.anchor.push(`${page} → ${href} (no element with id="${c.id}")`);
      }
    } else {
      const problem = await checkExternal(c.url);
      if (problem) results.external.push(`${page} → ${c.url} (${problem})`);
    }
  }

  for (const src of new Set(assets)) {
    const c = classify(src, page);
    if (!c) continue;
    if (c.kind === 'internal') {
      const r = await get(BASE + c.path);
      if (!r.ok) results.asset.push(`${page} → ${src} (HTTP ${r.status})`);
    } else if (c.kind === 'external') {
      const problem = await checkExternal(c.url);
      if (problem) results.asset.push(`${page} → ${c.url} (${problem})`);
    }
  }
  console.log(`checked ${page} — ${hrefs.length} links, ${assets.length} assets`);
}

const section = (title, arr) => {
  console.log(`\n${title}: ${arr.length ? arr.length + ' problem(s)' : 'all OK'}`);
  arr.forEach(x => console.log('  ✗ ' + x));
};
section('Internal pages/links', results.internal);
section('In-page anchors', results.anchor);
section('Assets', results.asset);
section('External links', results.external);

const hardFails = results.internal.length + results.anchor.length + results.asset.length
                + (STRICT_EXTERNAL ? results.external.length : 0);
if (hardFails) { console.error(`\n${hardFails} blocking problem(s).`); process.exit(1); }
console.log('\nNo blocking link problems.');
