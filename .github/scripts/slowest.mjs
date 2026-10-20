#!/usr/bin/env node
// Appends the slowest test files of vitest JSON reports (`--reporter=json --outputFile.json=…`) to the job summary
// ($GITHUB_STEP_SUMMARY; stdout without it). Dependency-free; a missing or unreadable report is a note, not a failure.
//
//   node .github/scripts/slowest.mjs [--title T] [--top N] report.json [more.json …]
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { relative } from 'node:path';

const args = process.argv.slice(2);
let title = 'Slowest test files';
let top = 10;
const reports = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--title') title = args[++i];
  else if (args[i] === '--top') top = Number(args[++i]);
  else reports.push(args[i]);
}

const rows = [];
const notes = [];
for (const path of reports) {
  if (!existsSync(path)) { notes.push(`no report at \`${path}\` (the run stopped before writing it)`); continue; }
  let report;
  try { report = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { notes.push(`unreadable report \`${path}\`: ${e.message}`); continue; }
  for (const f of report.testResults ?? []) {
    const tests = f.assertionResults ?? [];
    const sum = tests.reduce((s, t) => s + (t.duration ?? 0), 0);
    // A file's wall time (collection, setup and its tests); the summed test durations when the times are missing.
    const wall = f.endTime > 0 && f.startTime > 0 ? f.endTime - f.startTime : sum;
    rows.push({ file: relative(process.cwd(), f.name), wall, tests: tests.length, status: f.status });
  }
}
rows.sort((a, b) => b.wall - a.wall);

const s = (ms) => (ms / 1000).toFixed(1);
const total = rows.reduce((t, r) => t + r.wall, 0);
let md = `### ${title}\n\n`;
if (rows.length > 0) {
  md += `${rows.length} file(s), ${s(total)} s summed (files run in parallel, so the sum exceeds the wall time).\n\n`;
  md += '| # | file | s | tests | status |\n|---:|---|---:|---:|---|\n';
  rows.slice(0, top).forEach((r, i) => { md += `| ${i + 1} | \`${r.file}\` | ${s(r.wall)} | ${r.tests} | ${r.status} |\n`; });
}
for (const n of notes) md += `\n_${n}_\n`;
md += '\n';

if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
else process.stdout.write(md);
