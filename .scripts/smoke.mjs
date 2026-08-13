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

// EdgeOne deploys asynchronously after a push, so a check that runs immediately
// can race the rollout. Retry the whole suite instead of reporting a false red.
const ATTEMPTS  = Number(process.env.SMOKE_ATTEMPTS || 4);
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

async function runSuite() {
  const failures = [];
  for (const [name, fn] of checks) {
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

console.log(`Smoke testing ${BASE}\n`);
let failures = [];
for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
  if (attempt > 1) {
    console.log(`\nRetry ${attempt}/${ATTEMPTS} after ${BACKOFF_MS / 1000}s (deploy may still be rolling out)...\n`);
    await sleep(BACKOFF_MS);
  }
  failures = await runSuite();
  if (failures.length === 0) break;
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failing after ${ATTEMPTS} attempts: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nAll smoke checks passed.');
