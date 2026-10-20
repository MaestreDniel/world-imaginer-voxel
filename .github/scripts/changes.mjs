#!/usr/bin/env node
// CI's first job: decides whether this push or pull request changes documentation only (the docs-only fast path:
// typecheck/build, unit and arch; no integration, no metrics). Dependency-free, so it runs before `npm ci`.
//
//   node .github/scripts/changes.mjs              writes docs_only=true|false to $GITHUB_OUTPUT (stdout without it)
//   node .github/scripts/changes.mjs --self-test  checks the decision rules on sample inputs
//
// Docs are `docs/**` and `*.md` at any depth, nothing else. Any doubt runs the full path: an unknown event, a new
// branch (all-zero `before`), a force push, a `before` that is not in the clone or not an ancestor of HEAD, an empty
// diff, or a git error.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const isDocPath = (path) => path.startsWith('docs/') || path.endsWith('.md');

/** @returns {{ docsOnly: boolean, reason: string }} */
export function decide({ files }) {
  if (files.length === 0) return { docsOnly: false, reason: 'empty diff: full path' };
  const code = files.filter((f) => !isDocPath(f));
  if (code.length > 0) return { docsOnly: false, reason: `${code.length} non-doc file(s), e.g. ${code.slice(0, 5).join(', ')}` };
  return { docsOnly: true, reason: `${files.length} doc file(s) only` };
}

/**
 * The base to diff HEAD against, or null for the full path. `git` is `(args) => stdout`, throwing on a non-zero exit.
 * @returns {{ base: string | null, range: string, reason: string }}
 */
export function resolveBase({ event, before, forced, prBase }, git) {
  if (event === 'pull_request') {
    if (!prBase) return { base: null, range: '', reason: 'pull request without a base sha: full path' };
    // Three dots: from the merge base, so commits that landed on the base branch meanwhile do not count.
    return { base: prBase, range: `${prBase}...HEAD`, reason: `pull request against ${prBase}` };
  }
  if (event !== 'push') return { base: null, range: '', reason: `event ${event || '(none)'}: full path` };
  if (!before || /^0+$/.test(before)) return { base: null, range: '', reason: 'new branch (no before): full path' };
  if (forced === 'true') return { base: null, range: '', reason: 'force push: full path' };
  try {
    git(['cat-file', '-e', `${before}^{commit}`]);
  } catch {
    return { base: null, range: '', reason: `before ${before} not in the clone: full path` };
  }
  try {
    git(['merge-base', '--is-ancestor', before, 'HEAD']);
  } catch {
    return { base: null, range: '', reason: `before ${before} is not an ancestor of HEAD: full path` };
  }
  return { base: before, range: `${before}..HEAD`, reason: `push from ${before}` };
}

export function run(env, git) {
  const r = resolveBase({
    event: env.GITHUB_EVENT_NAME, before: env.BEFORE, forced: env.FORCED, prBase: env.PR_BASE,
  }, git);
  if (r.base === null) return { docsOnly: false, reason: r.reason, files: [] };
  let files;
  try {
    files = git(['diff', '--name-only', r.range]).split('\n').filter((f) => f.length > 0);
  } catch {
    return { docsOnly: false, reason: `git diff ${r.range} failed: full path`, files: [] };
  }
  const d = decide({ files });
  return { docsOnly: d.docsOnly, reason: `${r.reason}; ${d.reason}`, files };
}

function selfTest() {
  let failures = 0;
  const check = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
  };
  const docs = (files) => decide({ files }).docsOnly;
  check('docs/ only', docs(['docs/superpowers/specs/x-design.md', 'docs/superpowers/specs/assets/sp3e/a.png']), true);
  check('root and nested .md', docs(['README.md', 'CLAUDE.md', 'test/metrics/README.md']), true);
  check('docs json asset', docs(['docs/superpowers/specs/assets/sp3e/selftest-firefox.json']), true);
  check('md plus source', docs(['README.md', 'src/gen/terrain.ts']), false);
  check('lock file', docs(['docs/a.md', 'test/thresholds.lock.json']), false);
  check('workflow', docs(['.github/workflows/ci.yml']), false);
  check('.md-like but not .md', docs(['notes.mdx', 'README.md.bak']), false);
  check('docs prefix without slash', docs(['docsets/a.txt']), false);
  check('empty', docs([]), false);

  const repo = (commits, ancestors) => (args) => {
    if (args[0] === 'cat-file') { if (!commits.includes(args[2].replace('^{commit}', ''))) throw new Error('missing'); return ''; }
    if (args[0] === 'merge-base') { if (!ancestors.includes(args[2])) throw new Error('not ancestor'); return ''; }
    if (args[0] === 'diff') return 'docs/a.md\nREADME.md\n';
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
  const g = repo(['aaa', 'bbb'], ['aaa']);
  const base = (ctx) => resolveBase(ctx, g).range;
  check('push fast-forward', base({ event: 'push', before: 'aaa', forced: 'false' }), 'aaa..HEAD');
  check('push new branch', base({ event: 'push', before: '0000000000000000000000000000000000000000', forced: 'false' }), '');
  check('push forced', base({ event: 'push', before: 'aaa', forced: 'true' }), '');
  check('push before missing', base({ event: 'push', before: 'ccc', forced: 'false' }), '');
  check('push before not ancestor', base({ event: 'push', before: 'bbb', forced: 'false' }), '');
  check('push no before', base({ event: 'push', before: '', forced: '' }), '');
  check('pull request', base({ event: 'pull_request', prBase: 'bbb' }), 'bbb...HEAD');
  check('pull request without base', base({ event: 'pull_request', prBase: '' }), '');
  check('other event', base({ event: 'workflow_dispatch' }), '');
  check('run: docs-only push', run({ GITHUB_EVENT_NAME: 'push', BEFORE: 'aaa', FORCED: 'false' }, g).docsOnly, true);
  check('run: new branch', run({ GITHUB_EVENT_NAME: 'push', BEFORE: '0'.repeat(40), FORCED: 'false' }, g).docsOnly, false);
  check('run: diff fails', run({ GITHUB_EVENT_NAME: 'push', BEFORE: 'aaa', FORCED: 'false' }, (a) => {
    if (a[0] === 'diff') throw new Error('boom');
    return g(a);
  }).docsOnly, false);
  if (failures > 0) { console.error(`${failures} self-test failure(s)`); process.exit(1); }
  console.log('self-test passed');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--self-test')) selfTest();
  else {
    const git = (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const r = run(process.env, git);
    const line = `docs_only=${r.docsOnly}`;
    console.log(`${line} (${r.reason})`);
    for (const f of r.files.slice(0, 50)) console.log(`  ${f}`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${line}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `**Docs-only fast path:** ${r.docsOnly ? 'yes' : 'no'} (${r.reason})\n`);
    }
  }
}
