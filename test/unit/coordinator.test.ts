import { describe, expect, test } from 'vitest';
import { colKey } from '../../src/core/coords';
import {
  LoadError, createCoordinator, phaseName, progressFraction, type CoordinatorJobs, type JobOutcome, type LoadProgress,
} from '../../src/engine/coordinator';
import { JobCancelled } from '../../src/engine/workerPool';
import { discOffsets, type Stage } from '../../src/engine/rings';
import type { ColumnMeshPayload } from '../../src/mesh/column';

const RANK: Record<Stage, number> = { T: 1, D: 2, L: 3, MESH: 4 };

interface Issued { readonly stage: Stage; readonly cx: number; readonly cz: number }
interface Pending extends Issued {
  readonly resolve: (o: JobOutcome) => void;
  readonly reject: (e: unknown) => void;
}

interface FakeOptions {
  /** The versions a job reports; default: a copy of `versionsAt` (as read before the job). */
  readonly versionsOf?: (stage: Stage, cx: number, cz: number, atIntake: Int32Array) => Int32Array | null;
  /** An error to reject this job with, or null. */
  readonly failOf?: (stage: Stage, cx: number, cz: number) => unknown;
}

/**
 * Fake jobs that resolve on a manual tick, with a model of the columns' reached stages updated when a job settles
 * (before the coordinator sees the result). Each issue is checked against the prerequisites and the caps.
 */
function fakeJobs(workers: number, fo: FakeOptions = {}) {
  const reached = new Map<number, number>();
  const at = (cx: number, cz: number) => reached.get(colKey(cx, cz)) ?? 0;
  const pending: Pending[] = [];
  const issued: Issued[] = [];
  const violations: string[] = [];
  const inFlight: Record<Stage, number> = { T: 0, D: 0, L: 0, MESH: 0 };
  let total = 0;
  const versions = () => new Int32Array(18);
  const jobs: CoordinatorJobs = {
    run(stage, cx, cz) {
      issued.push({ stage, cx, cz });
      const need = RANK[stage] - 1;
      if (at(cx, cz) !== need) violations.push(`${stage} at (${cx}, ${cz}) issued with its column at ${at(cx, cz)}`);
      if (stage !== 'T') {
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (at(cx + dx, cz + dz) < need) violations.push(`${stage} at (${cx}, ${cz}) before (${cx + dx}, ${cz + dz}) reached ${need}`);
          }
        }
      }
      inFlight[stage]++;
      total++;
      if (inFlight.T > workers - 1) violations.push(`${inFlight.T} T in flight`);
      if (inFlight.MESH > workers) violations.push(`${inFlight.MESH} MESH in flight`);
      if (total > workers) violations.push(`${total} jobs in flight`);
      return new Promise<JobOutcome>((resolve, reject) => {
        const settle = () => { inFlight[stage]--; total--; };
        pending.push({
          stage, cx, cz,
          resolve: (o) => { settle(); reached.set(colKey(cx, cz), RANK[stage]); resolve(o); },
          reject: (e) => { settle(); reject(e); },
        });
      });
    },
  };
  /** Settles the pending job at index i (FIFO by default). */
  const settle = (i = 0) => {
    const p = pending.splice(i, 1)[0]!;
    const fail = fo.failOf?.(p.stage, p.cx, p.cz) ?? null;
    if (fail !== null) { p.reject(fail); return; }
    const v = fo.versionsOf ? fo.versionsOf(p.stage, p.cx, p.cz, versions()) : (p.stage === 'L' || p.stage === 'MESH' ? versions() : null);
    const payload = p.stage === 'MESH' ? ({ cx: p.cx, cz: p.cz, versions: v } as unknown as ColumnMeshPayload) : null;
    p.resolve({ versions: v, payload });
  };
  return { jobs, pending, issued, violations, settle, versionsAt: (_cx: number, _cz: number) => versions() };
}

const flush = () => new Promise<void>((r) => setImmediate(r));

/** A small LCG for a reproducible settle order. */
function lcg(seed: number) {
  let s = seed >>> 0;
  return (n: number) => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s % n; };
}

interface Run {
  readonly error: unknown;
  readonly meshes: ColumnMeshPayload[];
  readonly progress: LoadProgress[];
  readonly fake: ReturnType<typeof fakeJobs>;
}

async function runLoad(cx: number, cz: number, rd: number, workers: number, fo: FakeOptions = {}, order: 'fifo' | number = 'fifo'): Promise<Run> {
  const fake = fakeJobs(workers, fo);
  const meshes: ColumnMeshPayload[] = [];
  const progress: LoadProgress[] = [];
  const c = createCoordinator({
    workers, jobs: fake.jobs, versionsAt: fake.versionsAt,
    onMesh: (p) => meshes.push(p), onProgress: (p) => progress.push(p),
  });
  let settled = false;
  let error: unknown = null;
  c.load(cx, cz, rd).then(() => { settled = true; }, (e: unknown) => { settled = true; error = e; });
  const pick = order === 'fifo' ? () => 0 : lcg(order);
  while (!settled) {
    if (fake.pending.length === 0) {
      await flush();
      if (!settled && fake.pending.length === 0) throw new Error('the load stalled with nothing in flight');
      continue;
    }
    fake.settle(pick(fake.pending.length));
    await flush();
  }
  return { error, meshes, progress, fake };
}

describe('createCoordinator (SP4a spec §2.2)', () => {
  test('the first job is T at the centre; MESH at the centre is issued before any T at distance 13', async () => {
    const r = await runLoad(3, -2, 12, 4);
    expect(r.error).toBeNull();
    const log = r.fake.issued;
    expect(log[0]).toEqual({ stage: 'T', cx: 3, cz: -2 });
    const meshCentre = log.findIndex((j) => j.stage === 'MESH' && j.cx === 3 && j.cz === -2);
    const farT = log.findIndex((j) => j.stage === 'T' && Math.hypot(j.cx - 3, j.cz + 2) >= 13);
    expect(meshCentre).toBeGreaterThanOrEqual(0);
    expect(farT).toBeGreaterThan(meshCentre);
    // Nearest-first: the T jobs are issued in non-decreasing distance (T jobs only wait on the cap, never on each other).
    const tD2 = log.filter((j) => j.stage === 'T').map((j) => (j.cx - 3) ** 2 + (j.cz + 2) ** 2);
    for (let i = 1; i < tD2.length; i++) expect(tD2[i]!).toBeGreaterThanOrEqual(tD2[i - 1]!);
  });

  test('D is never issued before its 3 × 3 are T-done, nor L before D-done, nor MESH before L-done', async () => {
    for (const [workers, order] of [[2, 'fifo'], [4, 7], [6, 12345]] as const) {
      const r = await runLoad(-20, 9, 8, workers, {}, order);
      expect(r.error).toBeNull();
      expect(r.fake.violations.filter((v) => !v.includes('in flight'))).toEqual([]);
    }
  });

  test('never more than N − 1 T and N MESH in flight, and never more than N in total', async () => {
    for (const [workers, order] of [[2, 3], [3, 'fifo'], [5, 99], [6, 'fifo']] as const) {
      const r = await runLoad(0, 0, 6, workers, {}, order);
      expect(r.error).toBeNull();
      expect(r.fake.violations).toEqual([]);
    }
    expect(() => createCoordinator({ workers: 1, jobs: fakeJobs(1).jobs, versionsAt: () => new Int32Array(18), onMesh: () => {}, onProgress: () => {} })).toThrow(RangeError);
  });

  test('a MESH versions mismatch at intake rejects with LoadError \'dropped result\'; an L result whose lightVersions moved but blockVersions did not is accepted', async () => {
    const lightMoved = await runLoad(0, 0, 5, 3, {
      versionsOf: (stage, _cx, _cz, v) => {
        if (stage === 'L') for (let i = 1; i < 18; i += 2) v[i] = v[i]! + 7;
        return stage === 'L' || stage === 'MESH' ? v : null;
      },
    });
    expect(lightMoved.error).toBeNull();
    expect(lightMoved.meshes.length).toBe(discOffsets(5).length);

    const meshMoved = await runLoad(0, 0, 5, 3, {
      versionsOf: (stage, cx, cz, v) => {
        if (stage === 'MESH' && cx === 1 && cz === 0) v[9] = 1;
        return stage === 'L' || stage === 'MESH' ? v : null;
      },
    });
    expect(meshMoved.error).toBeInstanceOf(LoadError);
    const e = meshMoved.error as LoadError;
    expect(e.message).toMatch(/dropped result/);
    expect(e.column).toEqual([1, 0]);
    expect(meshMoved.progress.at(-1)!.dropped).toBe(1);
    expect(meshMoved.meshes.some((p) => p.cx === 1 && p.cz === 0)).toBe(false);

    const blockMoved = await runLoad(0, 0, 5, 3, {
      versionsOf: (stage, cx, cz, v) => {
        if (stage === 'L' && cx === -1 && cz === 2) v[8] = 3;
        return stage === 'L' || stage === 'MESH' ? v : null;
      },
    });
    expect(blockMoved.error).toBeInstanceOf(LoadError);
    expect((blockMoved.error as LoadError).message).toMatch(/dropped result/);
    expect((blockMoved.error as LoadError).column).toEqual([-1, 2]);
  });

  test('a job rejection rejects with LoadError carrying the column', async () => {
    const boom = new Error('boom');
    const failed = await runLoad(10, 10, 4, 4, { failOf: (stage, cx, cz) => (stage === 'D' && cx === 11 && cz === 9 ? boom : null) });
    expect(failed.error).toBeInstanceOf(LoadError);
    const e = failed.error as LoadError;
    expect(e.column).toEqual([11, 9]);
    expect(e.cause).toBe(boom);
    expect(e.message).toMatch(/boom/);

    const cancelled = await runLoad(0, 0, 4, 2, { failOf: (stage, cx, cz) => (stage === 'MESH' && cx === 0 && cz === 0 ? new JobCancelled() : null) });
    expect(cancelled.error).toBeInstanceOf(LoadError);
    expect((cancelled.error as LoadError).cause).toBeInstanceOf(JobCancelled);
    expect((cancelled.error as LoadError).column).toEqual([0, 0]);
    // Nothing is issued once the load has failed, and the jobs still in flight settle into nothing.
    const after = cancelled.fake.issued.length;
    const meshes = cancelled.meshes.length;
    while (cancelled.fake.pending.length > 0) { cancelled.fake.settle(); await flush(); }
    expect(cancelled.fake.issued.length).toBe(after);
    expect(cancelled.meshes.length).toBe(meshes);
  });

  test('progress counts reach needed; progressFraction is 1 with uploads done', async () => {
    const r = await runLoad(0, 0, 12, 6, {}, 2026);
    expect(r.error).toBeNull();
    const first = r.progress[0]!;
    const last = r.progress.at(-1)!;
    const needed = { T: 825, D: 705, L: 593, MESH: 489 };
    expect(first.needed).toEqual(needed);
    expect(first.done).toEqual({ T: 0, D: 0, L: 0, MESH: 0 });
    expect(last.needed).toEqual(needed);
    expect(last.done).toEqual(needed);
    expect(last.dropped).toBe(0);
    for (let i = 1; i < r.progress.length; i++) {
      expect(progressFraction(r.progress[i]!, 0, 1)).toBeGreaterThanOrEqual(progressFraction(r.progress[i - 1]!, 0, 1));
    }
    expect(progressFraction(first, 0, 0)).toBe(0);
    expect(progressFraction(last, 0, 300)).toBeCloseTo(0.85, 12);
    expect(progressFraction(last, 300, 300)).toBe(1);
    expect(phaseName(first, 0, 0)).toBe('Generating');
    expect(phaseName(last, 0, 300)).toBe('Preparing the view');
  });

  test('onMesh is called once per MESH column, 489 at rd 12', async () => {
    const r = await runLoad(-7, 40, 12, 4, {}, 5);
    expect(r.error).toBeNull();
    expect(r.meshes.length).toBe(489);
    expect(new Set(r.meshes.map((p) => colKey(p.cx, p.cz))).size).toBe(489);
    for (const p of r.meshes) expect((p.cx + 7) ** 2 + (p.cz - 40) ** 2).toBeLessThanOrEqual(12.5 ** 2);
  });
});

describe('progressFraction and phaseName (SP4a spec §8.3)', () => {
  const p = (done: Partial<Record<Stage, number>>): LoadProgress => ({
    needed: { T: 10, D: 10, L: 10, MESH: 10 },
    done: { T: 0, D: 0, L: 0, MESH: 0, ...done },
    dropped: 0,
  });

  test('the fraction is 0.2·T + 0.05·D + 0.25·L + 0.35·MESH + 0.15·uploads, each done/needed', () => {
    expect(progressFraction(p({ T: 10 }), 0, 4)).toBeCloseTo(0.2, 12);
    expect(progressFraction(p({ T: 10, D: 10 }), 0, 4)).toBeCloseTo(0.25, 12);
    expect(progressFraction(p({ T: 10, D: 10, L: 5 }), 0, 4)).toBeCloseTo(0.375, 12);
    expect(progressFraction(p({ T: 10, D: 10, L: 10, MESH: 10 }), 2, 4)).toBeCloseTo(0.925, 12);
  });

  test('the phase is the earliest stage still running: Generating (T, D), Lighting, Meshing, then Preparing the view', () => {
    expect(phaseName(p({ T: 9 }), 0, 0)).toBe('Generating');
    expect(phaseName(p({ T: 10, D: 9, L: 3 }), 0, 0)).toBe('Generating');
    expect(phaseName(p({ T: 10, D: 10, L: 3 }), 0, 0)).toBe('Lighting');
    expect(phaseName(p({ T: 10, D: 10, L: 10, MESH: 9 }), 0, 0)).toBe('Meshing');
    expect(phaseName(p({ T: 10, D: 10, L: 10, MESH: 10 }), 4, 4)).toBe('Preparing the view');
  });
});
