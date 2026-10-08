import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type TestContext } from 'vitest';
import type { MetricId, SubProjectId } from '../../src/core/ids';
import { THRESHOLDS, type MetricsTier, type ThresholdTable } from '../thresholds';
import { STARTED_SPS } from './sp';

const OUT_DIR = fileURLToPath(new URL('../metrics/.out/', import.meta.url));

export interface MetricEvaluation {
  asserted: string[];
  inactive: string[];
  /** Active parts whose row lists tiers that exclude this run's tier: measured and recorded, not gated. */
  otherTier: string[];
  errors: string[];
}

const TIERS: readonly MetricsTier[] = ['fast', 'quick', 'full'];

/** The tier of this metrics run (`METRICS_TIER`, set per vitest project; 'fast' outside them). */
export function currentTier(): MetricsTier {
  const t = process.env.METRICS_TIER ?? 'fast';
  if (t !== 'fast' && t !== 'quick' && t !== 'full') throw new Error(`METRICS_TIER '${t}' (fast, quick or full)`);
  return t;
}

export function evaluateMetric(
  id: string,
  parts: readonly string[],
  values: Readonly<Record<string, number>>,
  table: ThresholdTable = THRESHOLDS,
  started: readonly SubProjectId[] = STARTED_SPS,
  tier: MetricsTier = currentTier(),
): MetricEvaluation {
  const result: MetricEvaluation = { asserted: [], inactive: [], otherTier: [], errors: [] };
  const row = table[id as MetricId];
  for (const part of parts) {
    const t = row?.[part];
    if (!t) { result.errors.push(`${id}.${part}: not in THRESHOLDS`); continue; }
    const value = values[part];
    if (value === undefined) { result.errors.push(`${id}.${part}: no value returned`); continue; }
    if (!started.includes(t.activeFrom)) { result.inactive.push(part); continue; }
    if (t.tiers !== undefined && !t.tiers.includes(tier)) { result.otherTier.push(part); continue; }
    result.asserted.push(part);
    // NaN compares false against both bounds, so it would pass them: a gated NaN is an error of its own.
    if (Number.isNaN(value)) { result.errors.push(`${id}.${part} = NaN (not a number)`); continue; }
    if (t.min !== undefined && value < t.min) result.errors.push(`${id}.${part} = ${value} < min ${t.min}`);
    if (t.max !== undefined && value > t.max) result.errors.push(`${id}.${part} = ${value} > max ${t.max}`);
  }
  return result;
}

/**
 * What a metric test runs against. Every field defaults to this run's (vitest's `test`, `THRESHOLDS`, `STARTED_SPS`,
 * `currentTier()`, `test/metrics/.out/`); the unit tests of the harness override them.
 */
export interface MetricEnv {
  readonly register?: (name: string, fn: (ctx: TestContext) => Promise<void>, timeout?: number) => void;
  readonly table?: ThresholdTable;
  readonly started?: readonly SubProjectId[];
  readonly tier?: MetricsTier;
  readonly outDir?: string;
  /**
   * The `.out` file's base name (default: the metric id). A second `metricTest` call for an id (disjoint parts, e.g.
   * SP3c's voxel parts of B4 and B2) passes its own name so it does not overwrite the first call's record.
   */
  readonly outName?: string;
}

/**
 * Registers one metric test. Inactive parts, and parts gated on other tiers only, still run and record their value;
 * the test is skipped when no part is gated on this run, unless it has already failed: a skip would replace the
 * result and drop the errors `expect.soft` recorded (an "insufficient sample", SP3b spec §8.1), so a failed test
 * stays failed.
 */
export function metricTest(
  id: MetricId,
  parts: readonly string[],
  run: () => Record<string, number> | Promise<Record<string, number>>,
  timeoutMs = 600_000,
  env: MetricEnv = {},
): void {
  const { register = test, table = THRESHOLDS, started = STARTED_SPS, outDir = OUT_DIR, outName = id } = env;
  register(id, async (ctx) => {
    const values = await run();
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, `${outName}.json`), `${JSON.stringify({ id, tier: process.env.METRICS_TIER ?? null, values }, null, 2)}\n`);
    const r = evaluateMetric(id, parts, values, table, started, env.tier ?? currentTier());
    expect(r.errors, r.errors.join('\n')).toEqual([]);
    if (r.asserted.length === 0 && ctx.task.result?.state !== 'fail') {
      const why = [
        ...r.inactive.map((p) => `${p} inactive until ${table[id]?.[p]?.activeFrom}`),
        ...r.otherTier.map((p) => `${p} gated on ${table[id]?.[p]?.tiers?.join(', ')} only`),
      ];
      ctx.skip(true, `${why.join('; ')} (value recorded)`);
    }
  }, timeoutMs);
}

export interface MetricCall {
  file: string;
  id: string;
  parts: string[];
  /**
   * The `.out` file's base name (`MetricEnv.outName`; absent: the id). null: the call passes an outName that is not a
   * string literal, which the scan cannot read.
   */
  outName?: string | null;
}

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.metric.ts')) out.push(full);
  }
}

export function findMetricCalls(root: string): MetricCall[] {
  const files: string[] = [];
  walk(join(root, 'test', 'metrics'), files);
  const calls: MetricCall[] = [];
  const re = /metricTest\(\s*['"]([A-Z]+\d+[a-z]*)['"]\s*,\s*\[([^\]]*)\]/g;
  for (const file of files.sort()) {
    const text = readFileSync(file, 'utf8');
    const matches = [...text.matchAll(re)];
    matches.forEach((m, i) => {
      const parts = m[2]!.split(',').map((p) => p.trim().replace(/^['"]|['"]$/g, '')).filter((p) => p.length > 0);
      // The call's env is its last argument: an `outName` between this call and the next is this call's.
      const body = text.slice(m.index, matches[i + 1]?.index ?? text.length);
      const named = /\boutName\s*:\s*(?:'([^'\n]*)'|"([^"\n]*)")/.exec(body);
      const outName = named !== null ? (named[1] ?? named[2]!) : /\boutName\b/.test(body) ? null : m[1]!;
      calls.push({ file: relative(root, file).split('\\').join('/'), id: m[1]!, parts, outName });
    });
  }
  return calls;
}

export function coverageErrors(
  calls: readonly MetricCall[],
  table: ThresholdTable = THRESHOLDS,
  started: readonly SubProjectId[] = STARTED_SPS,
): string[] {
  const errors: string[] = [];
  // SP3c spec §5.2: a second call for an id names its own .out file, so neither record replaces the other.
  const writers = new Map<string, MetricCall[]>();
  for (const call of calls) {
    if (call.outName === null) { errors.push(`${call.file}: ${call.id} has an outName that is not a string literal`); continue; }
    const name = call.outName ?? call.id;
    writers.set(name, [...(writers.get(name) ?? []), call]);
  }
  for (const [name, w] of writers) {
    if (w.length > 1) errors.push(`${[...new Set(w.map((c) => c.id))].join(', ')}: ${w.length} metricTest calls write .out/${name}.json`);
  }
  for (const call of calls) {
    const row = table[call.id as MetricId];
    if (!row) { errors.push(`${call.file}: ${call.id} is not in THRESHOLDS`); continue; }
    for (const part of call.parts) if (!row[part]) errors.push(`${call.file}: ${call.id}.${part} is not in THRESHOLDS`);
  }
  for (const [id, row] of Object.entries(table)) {
    for (const [part, t] of Object.entries(row ?? {})) {
      if (t.tiers !== undefined) {
        const bad = t.tiers.filter((x, i) => !TIERS.includes(x) || t.tiers!.indexOf(x) !== i);
        if (t.tiers.length === 0 || bad.length > 0) errors.push(`${id}.${part}: tiers [${t.tiers.join(', ')}] (a non-empty subset of fast, quick, full)`);
      }
      if (!started.includes(t.activeFrom)) continue;
      const n = calls.filter((c) => c.id === id && c.parts.includes(part)).length;
      if (n === 0) errors.push(`${id}.${part} is active but no metricTest covers it`);
      else if (n > 1) errors.push(`${id}.${part} is covered by ${n} metricTest calls`);
    }
  }
  return errors;
}
