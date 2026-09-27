import { createHash } from 'node:crypto';
import type { SubProjectId } from '../../src/core/ids';
import type { ThresholdPart, ThresholdTable } from '../thresholds';
import { spIndex } from './sp';

export interface GovernanceState {
  thresholds: ThresholdTable;
  startedSps: readonly SubProjectId[];
}

export interface LockFile {
  sha256: string;
  canonical: unknown;
}

export type ChangeKind = 'LOOSEN' | 'TIGHTEN' | 'NEUTRAL';

export interface LockChange {
  path: string;
  detail: string;
  kind: ChangeKind;
}

export function canonicalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v).sort()) {
      const value = (v as Record<string, unknown>)[key];
      if (value !== undefined) out[key] = canonicalize(value);
    }
    return out;
  }
  return v;
}

export function canonicalJson(v: unknown): string {
  return JSON.stringify(canonicalize(v));
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function makeLock(state: GovernanceState): LockFile {
  const canonical = canonicalize(state);
  return { sha256: sha256(JSON.stringify(canonical)), canonical };
}

export function verifyLock(lock: LockFile): boolean {
  return sha256(canonicalJson(lock.canonical)) === lock.sha256;
}

function partChanges(path: string, prev: ThresholdPart, next: ThresholdPart): LockChange[] {
  const out: LockChange[] = [];
  if (prev.min !== next.min) {
    const loosen = next.min === undefined || (prev.min !== undefined && next.min < prev.min);
    out.push({ path, detail: `min ${prev.min ?? '—'}→${next.min ?? '—'}`, kind: loosen ? 'LOOSEN' : 'TIGHTEN' });
  }
  if (prev.max !== next.max) {
    const loosen = next.max === undefined || (prev.max !== undefined && next.max > prev.max);
    out.push({ path, detail: `max ${prev.max ?? '—'}→${next.max ?? '—'}`, kind: loosen ? 'LOOSEN' : 'TIGHTEN' });
  }
  if (prev.activeFrom !== next.activeFrom) {
    const loosen = spIndex(next.activeFrom) > spIndex(prev.activeFrom);
    out.push({ path, detail: `activeFrom ${prev.activeFrom}→${next.activeFrom}`, kind: loosen ? 'LOOSEN' : 'TIGHTEN' });
  }
  return out;
}

export function diffGovernance(prev: GovernanceState, next: GovernanceState): LockChange[] {
  const out: LockChange[] = [];
  const ids = [...new Set([...Object.keys(prev.thresholds), ...Object.keys(next.thresholds)])].sort();
  for (const id of ids) {
    const a = prev.thresholds[id as keyof ThresholdTable] ?? {};
    const b = next.thresholds[id as keyof ThresholdTable] ?? {};
    for (const part of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      const path = `${id}.${part}`;
      const pa = a[part];
      const pb = b[part];
      if (pa && !pb) {
        const wasActive = prev.startedSps.includes(pa.activeFrom);
        out.push({ path, detail: 'removed', kind: wasActive ? 'LOOSEN' : 'NEUTRAL' });
      } else if (!pa && pb) {
        out.push({ path, detail: 'added', kind: 'TIGHTEN' });
      } else if (pa && pb) {
        out.push(...partChanges(path, pa, pb));
      }
    }
  }
  for (const sp of prev.startedSps) if (!next.startedSps.includes(sp)) out.push({ path: 'startedSps', detail: `removed ${sp}`, kind: 'LOOSEN' });
  for (const sp of next.startedSps) if (!prev.startedSps.includes(sp)) out.push({ path: 'startedSps', detail: `added ${sp}`, kind: 'TIGHTEN' });
  return out;
}

export function formatChanges(changes: readonly LockChange[]): string {
  return changes.map((c) => `${c.kind.padEnd(7)} ${c.path}  ${c.detail}`).join('\n');
}
