// Self-check: the privacy policy only describes things the code actually does.
// Run: node .scripts/test-privacy-claims.mjs
//
// WHY THIS EXISTS — audit SEC-08. legal.html had drifted from the code: it
// promised hashed IPs while auth.js stored raw ones, listed "Sign-in events"
// (the login_events table was dropped on 2026-08-23) and named OpenRouter as a
// processor (removed 2026-08-21). A privacy policy that is wrong is a legal
// problem under the DPDP Act, not a typo. Each claim below is pinned to the
// code that makes it true, so changing one without the other fails CI.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const legal = read('legal.html');
const auth = read('functions/auth.js');
const chat = read('functions/chat.js');

// Things that no longer exist must not be described.
assert.ok(!/Sign-in events/i.test(legal), 'legal.html describes sign-in events, but login_events was dropped');
assert.ok(!/OpenRouter/i.test(legal), 'legal.html names OpenRouter, which the code no longer calls');

// "We store a SHA-256 hash ... not the address itself" — true only while every
// rate-limit key goes through a hash.
assert.match(legal, /SHA-256 hash of your IP address/);
assert.ok(/const piiKey = /.test(auth) && !/`rl:[a-z:]*\$\{(clientIP|normalizedEmail|getClientIP)/.test(auth),
  'legal.html promises hashed IPs/emails, but an auth.js rate-limit key uses a raw value');
assert.match(chat, /hashIP\(clientIP\)/, 'chat.js guest quota must keep hashing the IP');

// "Download a copy … or delete your account … from Settings" — both must exist.
assert.match(read('chat.html'), /CONFIG\.chatHistory\.export/, 'Settings no longer offers the data export the policy promises');
assert.match(auth, /action === 'delete-account'/, 'the delete-account endpoint the policy promises is gone');

console.log('privacy claims: OK');
