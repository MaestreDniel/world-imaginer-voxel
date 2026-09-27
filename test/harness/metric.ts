import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import type { MetricId, SubProjectId } from '../../src/core/ids';
import { THRESHOLDS, type ThresholdTable } from '../thresholds';
import { STARTED_SPS } from './sp';

const OUT_DIR = fileURLToPath(new URL('../metrics/.out/', import.meta.url));

export interface MetricEvaluation {
  asserted: string[];
  inactive: string[];
  errors: string[];
}

export function evaluateMetric(
  id: string,
  parts: readonly string[],
  values: Readonly<Record<string, number>>,
  table: ThresholdTable = THRESHOLDS,
  started: readonly SubProjectId[] = STARTED_SPS,
): MetricEvaluation {
  const result: MetricEvaluation = { asserted: [], inactive: [], errors: [] };
  const row = table[id as MetricId];
  for (const part of parts) {
    const t = row?.[part];
    if (!t) { result.errors.push(`${id}.${part}: not in THRESHOLDS`); continue; }
    const value = values[part];
    if (value === undefined) { result.errors.push(`${id}.${part}: no value returned`); continue; }
    if (!started.includes(t.activeFrom)) { result.inactive.push(part); continue; }
    result.asserted.push(part);
    if (t.min !== undefined && value < t.min) result.errors.push(`${id}.${part} = ${value} < min ${t.min}`);
    if (t.max !== undefined && value > t.max) result.errors.push(`${id}.${part} = ${value} > max ${t.max}`);
  }
  return result;
}

/** Registers one metric test. Inactive parts still run and record their value, then the test is skipped. */
export function metricTest(
  id: MetricId,
  parts: readonly string[],
  run: () => Record<string, number> | Promise<Record<string, number>>,
  timeoutMs = 600_000,
): void {
  test(id, async (ctx) => {
    const values = await run();
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(join(OUT_DIR, `${id}.json`), `${JSON.stringify({ id, tier: process.env.METRICS_TIER ?? null, values }, null, 2)}\n`);
    const r = evaluateMetric(id, parts, values);
    expect(r.errors, r.errors.join('\n')).toEqual([]);
    if (r.asserted.length === 0) {
      const next = r.inactive.map((p) => THRESHOLDS[id]?.[p]?.activeFrom).join(', ');
      ctx.skip(true, `inactive until ${next} (value recorded)`);
    }
  }, timeoutMs);
}

export interface MetricCall {
  file: string;
  id: string;
  parts: string[];
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
  const re = /metricTest\(\s*['"]([A-Z]+\d+)['"]\s*,\s*\[([^\]]*)\]/g;
  for (const file of files.sort()) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(re)) {
      const parts = m[2]!.split(',').map((p) => p.trim().replace(/^['"]|['"]$/g, '')).filter((p) => p.length > 0);
      calls.push({ file: relative(root, file).split('\\').join('/'), id: m[1]!, parts });
    }
  }
  return calls;
}

export function coverageErrors(
  calls: readonly MetricCall[],
  table: ThresholdTable = THRESHOLDS,
  started: readonly SubProjectId[] = STARTED_SPS,
): string[] {
  const errors: string[] = [];
  for (const call of calls) {
    const row = table[call.id as MetricId];
    if (!row) { errors.push(`${call.file}: ${call.id} is not in THRESHOLDS`); continue; }
    for (const part of call.parts) if (!row[part]) errors.push(`${call.file}: ${call.id}.${part} is not in THRESHOLDS`);
  }
  for (const [id, row] of Object.entries(table)) {
    for (const [part, t] of Object.entries(row ?? {})) {
      if (!started.includes(t.activeFrom)) continue;
      const n = calls.filter((c) => c.id === id && c.parts.includes(part)).length;
      if (n === 0) errors.push(`${id}.${part} is active but no metricTest covers it`);
      else if (n > 1) errors.push(`${id}.${part} is covered by ${n} metricTest calls`);
    }
  }
  return errors;
}
