# Security Policy

EconIntel runs a live service with real accounts at
[econintel.edgeone.app](https://econintel.edgeone.app). If you find a
vulnerability, please tell me before telling anyone else.

## Reporting

**econintelai@gmail.com** — put `SECURITY` in the subject.

Include what you found, how to reproduce it, and what an attacker gets. A short
proof of concept is worth more than a scanner report.

This is a solo project run alongside school, so: I will acknowledge inside
**72 hours** and give you a fix timeline or an explanation inside **7 days**.
Please give me 90 days before public disclosure, or sooner by agreement if the
fix ships early. I am happy to credit you.

## Please do not

- run automated scanners, fuzzers or load tests against the live site — the free
  tier has hard rate limits and you will take the service down for real users
- access, modify or exfiltrate any account that is not yours
- test the password-reset or signup flows against email addresses you do not own
- open a public issue for anything security-relevant

Test against your own local copy wherever possible. `.env.example` lists what
you need; nothing in this repo requires production credentials to run.

## In scope

The code in this repository, and the deployed instance:

- authentication — signup, login, sessions, CSRF, OAuth, account deletion
- the edge functions in `functions/`
- prompt injection through retrieved RAG content
- the ingestion pipeline in `.rag/`

## Known and already public

These are documented rather than hidden, so please don't report them as new:

- **No HSTS, `nosniff` or `X-Frame-Options` on HTML responses.** EdgeOne serves
  static HTML from CDN cache without invoking Pages middleware. A `<meta>` CSP
  and a JS framebuster cover part of it; the rest needs a dashboard rule. See
  README → *Security headers*.
- **`script-src` allows `'unsafe-inline'`** on all pages, and `'unsafe-eval'` on
  the landing page only. The pages are single files built on inline handlers,
  and the hero 3D viewer deserialises its scene with `new Function()`. The
  authenticated page does not get `'unsafe-eval'`.
- **`match_documents` is `SECURITY DEFINER` and callable by `anon`.** Deliberate
  — it is how retrieval survives row-level security, and the corpus is public
  source material. It still requires a valid API key, which is not in this repo.
- **Email verification is not wired up** and password-reset mail only reaches the
  account owner (Resend test sender). Both are tracked as open work.

## Not in scope

Findings that require a compromised device, physical access, or social
engineering; missing headers on third-party domains; and reports whose only
evidence is a scanner's output.
