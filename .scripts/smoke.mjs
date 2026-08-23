// scripts/smoke.mjs — end-to-end smoke test against the LIVE site.
//
// WHY: the feed checker catches a rotting RAG library, but nothing catches the
// failure that actually matters to a visitor — the chat returning an error
// instead of an answer. Edge functions fail silently: the site still serves,
// pages still 200, and only someone who types a question finds out. This test
// types a question.
//
// Run locally:  node scripts/smoke.mjs
// Against another origin:  BASE_URL=https://staging.example node scripts/smoke.mjs
//
// Exit 0 = all checks passed. Exit 1 = at least one failed.
//
// COST: one guest chat message per run (counts against the 5-per-IP-per-2h guest
// bucket and against LLM credits). That is why this runs on a schedule and on
// changes to functions/, not on every push.
import process from 'node:process';

const BASE = (process.env.BASE_URL || 'https://econintel.edgeone.app').replace(/\/$/, '');

// --cheap: run only the checks that cost NOTHING, so this file can double as a
// half-hourly heartbeat (.github/workflows/heartbeat.yml) instead of needing a
// second script. The one expensive check — actually sending a guest message —
// draws on the 5-per-IP-per-2h guest bucket and on LLM credits, so it stays in
// the daily run. Everything else is a plain HTTP request against a page or an
// endpoint that answers without touching the model.
const CHEAP = process.argv.includes('--cheap');

// EdgeOne deploys asynchronously after a push, so a check that runs immediately
// can race the rollout. Retry the whole suite instead of reporting a false red.
// NOT in --cheap mode: four attempts with a 30s backoff means a genuine outage
// is reported two minutes after it is already known, and a heartbeat that hides
// the first two minutes of downtime is not a heartbeat.
const ATTEMPTS   = CHEAP ? 1 : Number(process.env.SMOKE_ATTEMPTS || 4);
const BACKOFF_MS = 30000;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function req(path, opts = {}, timeoutMs = 45000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(`${BASE}${path}`, { ...opts, signal: ctrl.signal, redirect: 'follow' });
  } finally {
    clearTimeout(timer);
  }
}

// Each check returns null when it passes, or a string explaining the failure.
const checks = [
  ['landing page serves', async () => {
    const r = await req('/');
    if (r.status !== 200) return `expected 200, got ${r.status}`;
    const html = await r.text();
    if (!/hero-cta/.test(html)) return 'hero CTA missing — page served but content looks wrong';
    return null;
  }],

  ['chat page serves', async () => {
    const r = await req('/chat.html');
    return r.status === 200 ? null : `expected 200, got ${r.status}`;
  }],

  ['custom 404 returns a real 404', async () => {
    const r = await req('/definitely-not-a-real-page-smoke-test');
    if (r.status !== 404) return `expected 404, got ${r.status} (soft-404 confuses search engines)`;
    const html = await r.text();
    return /archive/i.test(html) ? null : 'custom 404 page not being served';
  }],

  ['robots.txt + sitemap.xml + favicon serve', async () => {
    for (const p of ['/robots.txt', '/sitemap.xml', '/favicon.svg']) {
      const r = await req(p);
      if (r.status !== 200) return `${p} returned ${r.status}`;
    }
    return null;
  }],

  ['edge functions alive (OPTIONS /chat)', async () => {
    const r = await req('/chat', { method: 'OPTIONS' });
    if (r.status !== 204) return `expected 204, got ${r.status} — functions may not be deployed`;
    if (r.headers.get('x-frame-options') !== 'DENY') return 'security headers missing on function response';
    return null;
  }],

  ['chat history requires auth', async () => {
    const r = await req('/chat-history?action=get');
    // 401 is the CORRECT answer here — an unauthenticated read must be refused.
    return r.status === 401 ? null : `expected 401 for unauthenticated read, got ${r.status}`;
  }],

  ['login rejects bad credentials without erroring', async () => {
    const r = await req('/auth?action=login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'smoke-test-nobody@example.com', password: 'definitely-wrong-password' }),
    });
    if (r.status >= 500) return `auth function is erroring: ${r.status}`;
    return r.status === 401 ? null : `expected 401 for bad credentials, got ${r.status}`;
  }],

  // THE ONE THAT MATTERS: a stranger with no account must get an answer.
  // The landing page promises "5 questions free — no signup, no card"; this
  // check is what makes that promise falsifiable.
  // COSTS MONEY AND QUOTA — skipped by --cheap, see the note at the top.
  ['guest can chat without an account', async () => {
    const r = await req('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': BASE },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'In one sentence, what is inflation?' }] }),
    });

    if (r.status === 401) {
      const body = await r.text().catch(() => '');
      // Quota exhaustion is a PASS: the endpoint worked, this runner's IP just
      // used its 5. Any other 401 means guests genuinely cannot chat.
      if (/GUEST_QUOTA_EXCEEDED/.test(body)) return null;
      return `guests cannot chat — 401 ${body.slice(0, 160)}`;
    }
    if (r.status !== 200) return `expected 200, got ${r.status} ${(await r.text().catch(() => '')).slice(0, 160)}`;

    // Read the first chunk to confirm a real stream, not an empty 200.
    const reader = r.body.getReader();
    try {
      const { value } = await reader.read();
      const chunk = new TextDecoder().decode(value || new Uint8Array());
      if (!chunk.trim()) return 'streamed an empty response';
      if (/"error"/.test(chunk)) return `error inside stream: ${chunk.slice(0, 160)}`;
      return null;
    } finally {
      await reader.cancel().catch(() => {});
    }
  }],
];

// Advisories are things that ARE wrong but that this script cannot make anyone
// fix, because the fix lives in the EdgeOne dashboard rather than in the repo.
// They print, and they deliberately do NOT affect the exit code: a build that is
// red every single day for a known, already-filed reason teaches you to ignore
// red, which costs more than the thing it was warning about.
const advisories = [
  ['security headers on HTML', async () => {
    const r = await req('/chat.html');
    const missing = ['x-frame-options', 'strict-transport-security', 'x-content-type-options']
      .filter(h => !r.headers.get(h));
    return missing.length
      ? `${missing.join(', ')} absent — add an EdgeOne response-header rule (README > Security headers). `
        + `The <meta> CSP and the framebuster cover part of this from the repo; these three are header-only.`
      : null;
  }],
];

async function runSuite() {
  const failures = [];
  const suite = CHEAP ? checks.filter(([name]) => name !== 'guest can chat without an account') : checks;
  for (const [name, fn] of suite) {
    let problem;
    try {
      problem = await fn();
    } catch (err) {
      problem = `threw: ${err.message}`;
    }
    console.log(`${problem ? 'FAIL' : 'ok  '} ${name}${problem ? ` — ${problem}` : ''}`);
    if (problem) failures.push(name);
  }
  return failures;
}

console.log(`Smoke testing ${BASE}${CHEAP ? ' (cheap mode — no LLM call)' : ''}\n`);
let failures = [];
for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
  if (attempt > 1) {
    console.log(`\nRetry ${attempt}/${ATTEMPTS} after ${BACKOFF_MS / 1000}s (deploy may still be rolling out)...\n`);
    await sleep(BACKOFF_MS);
  }
  failures = await runSuite();
  if (failures.length === 0) break;
}

// Advisories run once, after the suite, and never change the exit code.
for (const [name, fn] of advisories) {
  let note;
  try { note = await fn(); } catch (err) { note = `could not check: ${err.message}`; }
  if (note) console.log(`note  ${name} — ${note}`);
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failing after ${ATTEMPTS} attempts: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nAll smoke checks passed.');
