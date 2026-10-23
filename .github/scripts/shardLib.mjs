// The shard tool CI's shard tables share (SP4b spec §1.1): a table names heavy files in their own shards and one
// catch-all shard (`null`), which excludes every named file, so a file added later runs in the catch-all without
// touching the table. The shard names are CI's matrix (`matrix`), so a shard added to a table always runs; `check`
// fails the job unless the shards list the project's files exactly once each. Each table is a CLI:
//
//   node .github/scripts/<table>.mjs matrix            the shard names as a JSON array
//   node .github/scripts/<table>.mjs check             fails unless the shards list the project's files once each
//   node .github/scripts/<table>.mjs run NAME REPORT   runs shard NAME, writing a vitest JSON report to REPORT
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const named = (shards) => Object.values(shards).filter((f) => f !== null).flat();

/** The vitest arguments selecting a shard's files (after `--project`). */
export function shardArgs(shards, name) {
  if (!Object.hasOwn(shards, name)) throw new Error(`unknown shard ${name}; shards: ${Object.keys(shards).join(', ')}`);
  const files = shards[name];
  return files === null ? named(shards).flatMap((f) => ['--exclude', f]) : files;
}

/**
 * Every rule of `check`, as messages (none when the table is sound): exactly one catch-all; every on-disk file in the
 * project; every named file in the project; each named shard lists exactly its files; no shard empty; no file in two
 * shards; none dropped; none outside the project. `all` is the project's listing, `listed` each shard's.
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
    if (shards[name] !== null && JSON.stringify(files) !== JSON.stringify([...shards[name]].sort())) {
      errors.push(`shard ${name} lists ${files.join(', ')}, not its named files ${shards[name].join(', ')}`);
    }
    for (const f of files) {
      if (seen.has(f)) errors.push(`${f} is in shards ${seen.get(f)} and ${name}`);
      else seen.set(f, name);
    }
  }
  const dropped = all.filter((f) => !seen.has(f));
  if (dropped.length > 0) errors.push(`no shard runs ${[...dropped].sort().join(', ')}`);
  const extra = [...seen.keys()].filter((f) => !all.includes(f));
  if (extra.length > 0) errors.push(`shards list files outside ${project}: ${extra.join(', ')}`);
  return errors;
}

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

/** A shard table's commands: `project` is the vitest project, `dir` its files' directory, `suffix` their suffix. */
export function shardTool({ project, dir, suffix, shards }) {
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
      const errors = coverageProblems({ project, shards, all, onDisk, listed });
      if (errors.length > 0) {
        for (const e of errors) console.error(`::error::${project} shards: ${e}`);
        process.exit(1);
      }
      console.log(`shards cover the ${all.length} ${project} files exactly once`);
    },
    run(name, report) {
      const args = ['vitest', 'run', '--project', project, ...shardArgs(shards, name),
        '--reporter=default', '--reporter=json', `--outputFile.json=${report}`];
      console.log(`npx ${args.join(' ')}`);
      const r = spawnSync(npx, args, { stdio: 'inherit' });
      process.exit(r.status ?? 1);
    },
  };
}

/** Runs a table's CLI (`matrix | check | run NAME REPORT`) when `url`, the table's `import.meta.url`, is the script. */
export function cli(url, tool, script) {
  if (!process.argv[1] || url !== pathToFileURL(process.argv[1]).href) return;
  const [cmd, name, report] = process.argv.slice(2);
  if (cmd === 'matrix') console.log(JSON.stringify(tool.matrix()));
  else if (cmd === 'check') tool.check();
  else if (cmd === 'run' && name && report) tool.run(name, report);
  else {
    console.error(`usage: ${script} matrix | check | run NAME REPORT`);
    process.exit(2);
  }
}
