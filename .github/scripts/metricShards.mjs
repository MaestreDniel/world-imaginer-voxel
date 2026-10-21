#!/usr/bin/env node
// The metrics-quick shards of CI: named heavy files in their own shards, and the catch-all shard `rest`, which
// excludes every named file, so a metric file added later runs in `rest` without touching this script. The shard
// names are CI's matrix (`matrix`), so a shard added here always runs. Rebalance by the job summaries' durations.
//
//   node .github/scripts/metricShards.mjs matrix            the shard names as a JSON array
//   node .github/scripts/metricShards.mjs check             fails unless the shards list the project's files once each
//   node .github/scripts/metricShards.mjs run NAME REPORT   runs shard NAME, writing a vitest JSON report to REPORT
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const PROJECT = 'metrics-quick';
const DIR = 'test/metrics';

/**
 * Shard name → its files; `rest` is the catch-all. Measured 2026-10-20 (cold region cache, alone on 4 CPUs of an
 * i7-12700H): terrain 167 s (T1), surface 167 s (S1), noise 108 s, the other seven files 80 s together; noise in `rest`.
 */
export const SHARDS = {
  terrain: [`${DIR}/terrain.metric.ts`],
  surface: [`${DIR}/surface.metric.ts`],
  // SP4a spec §10 (D28): the renderer's metric files (R1, R2, R4, R5 so far), with their cold region caches.
  render: [`${DIR}/render.metric.ts`],
  rest: null,
};

const named = () => Object.values(SHARDS).filter((f) => f !== null).flat();

/** The vitest arguments selecting a shard's files (after `--project`). */
export function shardArgs(name) {
  if (!(name in SHARDS)) throw new Error(`unknown shard ${name}; shards: ${Object.keys(SHARDS).join(', ')}`);
  const files = SHARDS[name];
  return files === null ? named().flatMap((f) => ['--exclude', f]) : files;
}

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

function list(args) {
  // `--json=<file>`: a piped stdout can come back empty when vitest exits before it drains.
  const dir = mkdtempSync(join(tmpdir(), 'metric-shards-'));
  const out = join(dir, 'list.json');
  try {
    const r = spawnSync(npx, ['vitest', 'list', '--project', PROJECT, '--filesOnly', `--json=${out}`, ...args], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`vitest list ${args.join(' ')} failed (${r.status}):\n${r.stderr}${r.stdout}`);
    return JSON.parse(readFileSync(out, 'utf8')).map((e) => relative(process.cwd(), e.file)).sort();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function check() {
  const errors = [];
  if (Object.values(SHARDS).filter((f) => f === null).length !== 1) errors.push('there must be exactly one catch-all shard');
  const all = list([]);
  const onDisk = readdirSync(DIR).filter((f) => f.endsWith('.metric.ts')).map((f) => `${DIR}/${f}`).sort();
  const missingFromProject = onDisk.filter((f) => !all.includes(f));
  if (missingFromProject.length > 0) errors.push(`${PROJECT} does not list ${missingFromProject.join(', ')}`);
  for (const f of named()) if (!all.includes(f)) errors.push(`named file ${f} is not in ${PROJECT}`);
  const seen = new Map();
  for (const name of Object.keys(SHARDS)) {
    const files = list(shardArgs(name));
    if (files.length === 0) errors.push(`shard ${name} has no files`);
    if (SHARDS[name] !== null && JSON.stringify(files) !== JSON.stringify([...SHARDS[name]].sort())) {
      errors.push(`shard ${name} lists ${files.join(', ')}, not its named files ${SHARDS[name].join(', ')}`);
    }
    for (const f of files) {
      if (seen.has(f)) errors.push(`${f} is in shards ${seen.get(f)} and ${name}`);
      else seen.set(f, name);
    }
    console.log(`${name}: ${files.join(' ')}`);
  }
  const dropped = all.filter((f) => !seen.has(f));
  if (dropped.length > 0) errors.push(`no shard runs ${dropped.join(', ')}`);
  const extra = [...seen.keys()].filter((f) => !all.includes(f));
  if (extra.length > 0) errors.push(`shards list files outside ${PROJECT}: ${extra.join(', ')}`);
  if (errors.length > 0) {
    for (const e of errors) console.error(`::error::metricShards: ${e}`);
    process.exit(1);
  }
  console.log(`shards cover the ${all.length} ${PROJECT} files exactly once`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, name, report] = process.argv.slice(2);
  if (cmd === 'matrix') console.log(JSON.stringify(Object.keys(SHARDS)));
  else if (cmd === 'check') check();
  else if (cmd === 'run' && name && report) {
    const args = ['vitest', 'run', '--project', PROJECT, ...shardArgs(name),
      '--reporter=default', '--reporter=json', `--outputFile.json=${report}`];
    console.log(`npx ${args.join(' ')}`);
    const r = spawnSync(npx, args, { stdio: 'inherit' });
    process.exit(r.status ?? 1);
  } else {
    console.error('usage: metricShards.mjs matrix | check | run NAME REPORT');
    process.exit(2);
  }
}
