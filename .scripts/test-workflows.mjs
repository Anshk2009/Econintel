// Self-check for the GitHub Actions workflows (.github/workflows/*.yml).
// Run: node .scripts/test-workflows.mjs
//
// WHY THIS EXISTS — audit SEC-16. The ingest workflows hold the Supabase
// service-role key and the NVIDIA key, and the repo is about to be public.
//   permissions — with no `permissions:` block a job gets the repository's
//     default GITHUB_TOKEN scope, which can be write-all. Nothing here writes to
//     the repo, so every workflow says `contents: read`.
//   pinned actions — `uses: actions/checkout@v4` follows a TAG, and a tag can be
//     moved. A compromised or re-pointed tag would run inside jobs that hold
//     those secrets. A full commit SHA cannot be moved.
//   Node — Node 20 reached end-of-life on 2026-04-30 (no more security fixes);
//     .package.json already says >=22.11.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const dir = new URL('../.github/workflows/', import.meta.url);
const files = readdirSync(dir).filter(f => f.endsWith('.yml'));
assert.ok(files.length >= 9, 'workflows not found');

const problems = [];
for (const f of files) {
  const y = readFileSync(new URL(f, dir), 'utf8');
  if (!/^permissions:\s*\n\s+contents:\s*read\s*$/m.test(y)) problems.push(`${f}: no top-level 'permissions: contents: read'`);
  for (const m of y.matchAll(/uses:\s*([^\s#]+)/g)) {
    if (!/@[0-9a-f]{40}$/.test(m[1])) problems.push(`${f}: '${m[1]}' is not pinned to a commit SHA`);
  }
  for (const m of y.matchAll(/node-version:\s*"?(\d+)"?/g)) {
    if (Number(m[1]) < 22) problems.push(`${f}: node-version ${m[1]} is end-of-life`);
  }
  if (/pip install (?!\S+==)/.test(y)) problems.push(`${f}: unpinned pip install`);
}
assert.equal(problems.length, 0, `workflow hardening:\n  ${problems.join('\n  ')}`);
console.log(`workflows: all ${files.length} hardened`);
