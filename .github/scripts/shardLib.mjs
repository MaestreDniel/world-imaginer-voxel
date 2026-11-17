// The shard tool CI's shard tables share (SP4b spec §1.1): a table names heavy files in their own shards and one
// catch-all shard (`null`), which excludes every named file, so a file added later runs in the catch-all without
// touching the table. The shard names are CI's matrix (`matrix`), so a shard added to a table always runs; `check`
// fails the job unless the shards list the project's files exactly once each. A shard is its files, or its files with
// the env its run sets (SP6b spec §13: a shard is named by (file, env)); a file may sit in several shards whose envs
// partition it (a variable both set, with distinct values), each run reading its part of the file from its env. A
// table may slice files by column (SP6b spec §13 Stage 2 item 1; the user's ruling U15): slice shards set
// `METRICS_SLICE=k/n` and its merge, run by its own job after the table's, sets `merge/n` (`sliceProblems`). Each table
// is a CLI:
//
//   node .github/scripts/<table>.mjs matrix            the shard names as a JSON array
//   node .github/scripts/<table>.mjs check             fails unless the shards list the project's files once each
//   node .github/scripts/<table>.mjs run NAME REPORT   runs shard NAME, writing a vitest JSON report to REPORT
//   node .github/scripts/<table>.mjs merge REPORT      runs the table's merge (a table with column slices)
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

/** A shard's files (null for the catch-all): a plain list, or an env shard's `files`. */
const filesOf = (shard) => (shard === null || Array.isArray(shard) ? shard : shard.files);
/** A shard's env: an env shard's `env`, else null. */
const envOf = (shard) => (shard === null || Array.isArray(shard) ? null : shard.env);
/** Every named file once, in table order. */
const named = (shards) => [...new Set(Object.values(shards).map(filesOf).filter((f) => f !== null).flat())];

function known(shards, name) {
  if (!Object.hasOwn(shards, name)) throw new Error(`unknown shard ${name}; shards: ${Object.keys(shards).join(', ')}`);
}

/** The vitest arguments selecting a shard's files (after `--project`). */
export function shardArgs(shards, name) {
  known(shards, name);
  const files = filesOf(shards[name]);
  return files === null ? named(shards).flatMap((f) => ['--exclude', f]) : files;
}

/** The env a shard's run sets (none for a plain shard or the catch-all). */
export function shardEnv(shards, name) {
  known(shards, name);
  return { ...(envOf(shards[name]) ?? {}) };
}

/**
 * Whether two shards' envs partition a file they both name: both set, and a variable both set with distinct values (a
 * column slice's `METRICS_SLICE` beside another profile's shard, which sets `METRICS_PROFILES` alone, ruling U15).
 */
function partitions(a, b) {
  if (a === null || b === null) return false;
  return Object.keys(a).some((k) => Object.hasOwn(b, k) && a[k] !== b[k]);
}

/**
 * Every rule of `check`, as messages (none when the table is sound): exactly one catch-all; every on-disk file in the
 * project; every named file in the project; each named shard lists exactly its files; no shard empty; no file in two
 * shards, unless their envs partition it (a variable both set, with distinct values); none dropped; none outside the
 * project. `all` is the project's listing, `listed` each shard's.
 */
export function coverageProblems({ project, shards, all, onDisk, listed }) {
  const errors = [];
  if (Object.values(shards).filter((f) => f === null).length !== 1) errors.push('there must be exactly one catch-all shard');
  const missingFromProject = onDisk.filter((f) => !all.includes(f));
  if (missingFromProject.length > 0) errors.push(`${project} does not list ${missingFromProject.join(', ')}`);
  for (const f of named(shards)) if (!all.includes(f)) errors.push(`named file ${f} is not in ${project}`);
  const seen = new Map();
  for (const name of Object.keys(shards)) {
    const files = [...(listed[name] ?? [])].sort();
    if (files.length === 0) errors.push(`shard ${name} has no files`);
    const own = filesOf(shards[name]);
    if (own !== null && JSON.stringify(files) !== JSON.stringify([...own].sort())) {
      errors.push(`shard ${name} lists ${files.join(', ')}, not its named files ${own.join(', ')}`);
    }
    for (const f of files) {
      const before = seen.get(f) ?? [];
      const clash = before.find((b) => !partitions(envOf(shards[b]), envOf(shards[name])));
      if (clash !== undefined) errors.push(`${f} is in shards ${clash} and ${name}`);
      else seen.set(f, [...before, name]);
    }
  }
  const dropped = all.filter((f) => !seen.has(f));
  if (dropped.length > 0) errors.push(`no shard runs ${[...dropped].sort().join(', ')}`);
  const extra = [...seen.keys()].filter((f) => !all.includes(f));
  if (extra.length > 0) errors.push(`shards list files outside ${project}: ${extra.join(', ')}`);
  return errors;
}

/**
 * A column slice's variable (SP6b spec §13 Stage 2 item 1; `test/harness/columnSlices.ts`): `k/n` on a slice shard,
 * `merge/n` on the merge.
 */
export const SLICE_VAR = 'METRICS_SLICE';

/**
 * Every rule of `check` on a table's column slices and its merge (SP6b spec §13 Stage 2 item 1; the user's ruling U15),
 * as messages (none when sound): a slice shard sets `METRICS_SLICE=k/n` (0 ≤ k < n, n ≥ 2) and its name holds `-slice-`
 * (ci.yml hands those shards' records to the merge job), no other shard's name does; slices need a merge; the merge
 * (`{ files, env }`) sets `merge/n` with the slices' n, its env otherwise equals each slice's, each slice's files are
 * the merge's, and each merge file has slices 0 … n − 1 once each.
 */
export function sliceProblems(shards, merge) {
  const errors = [];
  const slices = [];
  for (const [name, shard] of Object.entries(shards)) {
    const raw = envOf(shard)?.[SLICE_VAR];
    if (raw === undefined) {
      if (name.includes('-slice-')) errors.push(`shard ${name} is named as a slice but sets no ${SLICE_VAR}`);
      continue;
    }
    const m = /^(\d+)\/(\d+)$/.exec(raw);
    if (m === null || Number(m[2]) < 2 || Number(m[1]) >= Number(m[2])) {
      errors.push(`shard ${name}: ${SLICE_VAR} '${raw}' is not a slice k/n`);
      continue;
    }
    if (!name.includes('-slice-')) errors.push(`slice shard ${name}: its name must hold '-slice-'`);
    slices.push({ name, k: Number(m[1]), n: Number(m[2]), files: filesOf(shard), env: envOf(shard) });
  }
  if (merge === undefined) {
    if (slices.length > 0) errors.push(`slice shards ${slices.map((s) => s.name).join(', ')} but no merge`);
    return errors;
  }
  const mm = /^merge\/(\d+)$/.exec(merge.env[SLICE_VAR] ?? '');
  if (mm === null || Number(mm[1]) < 2) {
    errors.push(`the merge's ${SLICE_VAR} '${merge.env[SLICE_VAR]}' is not merge/n`);
    return errors;
  }
  const n = Number(mm[1]);
  const others = (env) => JSON.stringify(Object.entries(env).filter(([k]) => k !== SLICE_VAR).sort());
  for (const s of slices) {
    if (s.n !== n) errors.push(`slice shard ${s.name} is one of ${s.n}, the merge reads ${n}`);
    if (others(s.env) !== others(merge.env)) errors.push(`slice shard ${s.name}'s env differs from the merge's beyond ${SLICE_VAR}`);
    for (const f of s.files) if (!merge.files.includes(f)) errors.push(`slice shard ${s.name}'s ${f} is not the merge's`);
  }
  for (const f of merge.files) {
    const ks = slices.filter((s) => s.files.includes(f)).map((s) => s.k).sort((a, b) => a - b);
    if (JSON.stringify(ks) !== JSON.stringify(Array.from({ length: n }, (_, k) => k))) {
      errors.push(`the merge's ${f} has slices [${ks.join(', ')}], not 0 … ${n - 1}`);
    }
  }
  return errors;
}

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

/** Runs vitest on `files` of `project` with `env` set, writing a JSON report to `report`; exits with its status. */
function runVitest(project, files, env, report) {
  const args = ['vitest', 'run', '--project', project, ...files, '--reporter=default', '--reporter=json', `--outputFile.json=${report}`];
  console.log(`${Object.entries(env).map(([k, v]) => `${k}=${v} `).join('')}npx ${args.join(' ')}`);
  const r = spawnSync(npx, args, { stdio: 'inherit', env: { ...process.env, ...env } });
  process.exit(r.status ?? 1);
}

/**
 * A shard table's commands: `project` is the vitest project, `dir` its files' directory, `suffix` their suffix; `merge`
 * (optional) the merge of the table's column slices (`{ files, env }`, `sliceProblems`).
 */
export function shardTool({ project, dir, suffix, shards, merge }) {
  function list(args) {
    // `--json=<file>`: a piped stdout can come back empty when vitest exits before it drains.
    const tmp = mkdtempSync(join(tmpdir(), `${project}-shards-`));
    const out = join(tmp, 'list.json');
    try {
      const r = spawnSync(npx, ['vitest', 'list', '--project', project, '--filesOnly', `--json=${out}`, ...args], { encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`vitest list ${args.join(' ')} failed (${r.status}):\n${r.stderr}${r.stdout}`);
      return JSON.parse(readFileSync(out, 'utf8')).map((e) => relative(process.cwd(), e.file)).sort();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  return {
    matrix: () => Object.keys(shards),
    check() {
      const all = list([]);
      const onDisk = readdirSync(dir).filter((f) => f.endsWith(suffix)).map((f) => `${dir}/${f}`).sort();
      const listed = {};
      for (const name of Object.keys(shards)) {
        listed[name] = list(shardArgs(shards, name));
        console.log(`${name}: ${listed[name].join(' ')}`);
      }
      const errors = [...coverageProblems({ project, shards, all, onDisk, listed }), ...sliceProblems(shards, merge)];
      if (errors.length > 0) {
        for (const e of errors) console.error(`::error::${project} shards: ${e}`);
        process.exit(1);
      }
      console.log(`shards cover the ${all.length} ${project} files exactly once`);
      if (merge !== undefined) {
        console.log(`merge: ${merge.files.join(' ')} (${Object.entries(merge.env).map(([k, v]) => `${k}=${v}`).join(' ')}), its slices sound`);
      }
    },
    run(name, report) {
      runVitest(project, shardArgs(shards, name), shardEnv(shards, name), report);
    },
    merge(report) {
      if (merge === undefined) throw new Error(`${project} has no merge`);
      runVitest(project, merge.files, merge.env, report);
    },
  };
}

/**
 * Runs a table's CLI (`matrix | check | run NAME REPORT | merge REPORT`) when `url`, the table's `import.meta.url`, is
 * the script.
 */
export function cli(url, tool, script) {
  if (!process.argv[1] || url !== pathToFileURL(process.argv[1]).href) return;
  const [cmd, name, report] = process.argv.slice(2);
  if (cmd === 'matrix') console.log(JSON.stringify(tool.matrix()));
  else if (cmd === 'check') tool.check();
  else if (cmd === 'run' && name && report) tool.run(name, report);
  else if (cmd === 'merge' && name && !report) tool.merge(name);
  else {
    console.error(`usage: ${script} matrix | check | run NAME REPORT | merge REPORT`);
    process.exit(2);
  }
}
