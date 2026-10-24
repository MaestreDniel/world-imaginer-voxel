/**
 * The coordinator's one-shot core (SP4a spec §2.2, D6): it feeds the pool the T, D, L and MESH_COLUMN jobs of the
 * needed sets around a fixed centre (`rings.ts`), nearest-first under the prerequisite rules, checks each result at
 * intake, and resolves `load` once every MESH column's payload has been handed to `onMesh`. SP4b extends this module
 * with re-centring, cancellation, unload and the throttle (§13.1).
 *
 * - **States** per needed column: Absent → T → D → L → MESH, mirrored from job results (the store's `status` is the
 *   truth the workers read).
 * - **Readiness:** D needs the 3 × 3 at ≥ T, L the 3 × 3 at ≥ D, MESH the 3 × 3 at L; each job's column must also be
 *   in its own stage's set.
 * - **Order:** `d_h − stageBonus` (MESH 1.5, L 1.0, D 0.5, T 0; master §4.3), ties by colKey, no view term. The ready
 *   jobs are kept in one binary heap per stage under that same key, and the next job is the smallest top among the
 *   stages whose cap allows one more, which is the order of a single heap with capped stages skipped, without popping
 *   and re-pushing the jobs a cap holds back.
 * - **Caps:** T ≤ N − 1 and MESH ≤ N in flight, at most N in total (one per free worker), so the pool's queue never
 *   holds more than N jobs.
 * - **Intake** (the spec's rule made exact): an L job reads its neighbours' blocks and fluid but not their light, and
 *   its own commit and its neighbours' L commits legitimately bump `lightVersion`, so an L result is compared on the
 *   nine `blockVersion`s only (even indices); a MESH result on all 18 values (nothing writes a Published column). A
 *   mismatch with `versionsAt` counts in `dropped` and fails the load ("dropped result"; it cannot occur in SP4a). T
 *   and D results carry no versions. The epoch is the pool's: an old epoch's reply rejects as `JobCancelled`, which
 *   fails the load like any job rejection; `meshSeq` is SP4b's.
 */
import { colKey } from '../core/coords';
import type { ColumnMeshPayload } from '../mesh/column';
import { assertTorusSafe, stageOffsets, type Stage } from './rings';
import type { ColumnDone, WorkerPool } from './workerPool';

/** What a job resolved with: T and D carry no versions; L its 3 × 3 versions (18); MESH its payload and its versions. */
export interface JobOutcome {
  readonly versions: Int32Array | null;
  readonly payload: ColumnMeshPayload | null;
}

/**
 * The pool seen by the coordinator: one call per job (`worldJobsOf` adapts the pool). `protoOnly` (T only; SP4b spec
 * §3.7) is `T(protoOnly)`; it defaults to false for SP4a's three-argument callers.
 */
export interface CoordinatorJobs {
  run(stage: Stage, cx: number, cz: number, protoOnly?: boolean): Promise<JobOutcome>;
}

/**
 * The pool as the coordinator's jobs (ruling P30): T, D, L and MESH run `terrain`, `decorate`, `light` and `meshColumn`
 * (T with `protoOnly`, SP4b spec §3.7). T, D and L resolve `{ versions: done.versions, payload: null }` (light's 18
 * versions, null for terrain and decorate), MESH `{ versions: p.versions, payload: p }`. Rejections pass through
 * unchanged; the coordinator wraps them in LoadError.
 */
export function worldJobsOf(pool: Pick<WorkerPool, 'terrain' | 'decorate' | 'light' | 'meshColumn'>): CoordinatorJobs {
  const column = (d: ColumnDone): JobOutcome => ({ versions: d.versions, payload: null });
  return {
    run(stage, cx, cz, protoOnly = false) {
      switch (stage) {
        case 'T': return pool.terrain(cx, cz, protoOnly).then(column);
        case 'D': return pool.decorate(cx, cz).then(column);
        case 'L': return pool.light(cx, cz).then(column);
        case 'MESH': return pool.meshColumn(cx, cz).then((p) => ({ versions: p.versions, payload: p }));
      }
    },
  };
}

export interface CoordinatorOptions {
  /** N, the pool's size (≥ 2, so that T ≤ N − 1 leaves room for T). */
  readonly workers: number;
  readonly jobs: CoordinatorJobs;
  /** The store's 3 × 3 versions around (cx, cz) now (`NeighborhoodReader.versions()`). */
  readonly versionsAt: (cx: number, cz: number) => Int32Array;
  /** Called once per MESH column, with its payload. */
  readonly onMesh: (p: ColumnMeshPayload) => void;
  /** Called at the start and after every result. */
  readonly onProgress: (p: LoadProgress) => void;
}

/** Counts per stage (done / needed) and the dropped results (SP4a spec §2.2's Progress). */
export interface LoadProgress {
  readonly needed: Record<Stage, number>;
  readonly done: Record<Stage, number>;
  readonly dropped: number;
}

/** A load stopped by a job error or a dropped result; `column` is the job's column (SP4a spec §2.2's Errors). */
export class LoadError extends Error {
  override readonly cause: unknown;
  readonly column: readonly [number, number] | null;
  constructor(message: string, cause: unknown, column: readonly [number, number] | null) {
    super(message);
    this.name = 'LoadError';
    this.cause = cause;
    this.column = column;
  }
}

const STAGES: readonly Stage[] = ['T', 'D', 'L', 'MESH'];
const BONUS: readonly number[] = [0, 0.5, 1.0, 1.5];

const frac = (done: number, needed: number): number => (needed > 0 ? Math.min(1, done / needed) : 0);

/**
 * The loading bar's fraction (SP4a spec §8.3): `0.2·T + 0.05·D + 0.25·L + 0.35·MESH + 0.15·uploads`, each done/needed
 * (an empty total counts 0). Summed in hundredths, so a finished load reads exactly 1.
 */
export function progressFraction(p: LoadProgress, uploadsDone: number, uploadsTotal: number): number {
  const s = 20 * frac(p.done.T, p.needed.T) + 5 * frac(p.done.D, p.needed.D) + 25 * frac(p.done.L, p.needed.L)
    + 35 * frac(p.done.MESH, p.needed.MESH) + 15 * frac(uploadsDone, uploadsTotal);
  return s / 100;
}

/**
 * The loading screen's phase line (SP4a spec §8.3): the earliest stage still running, T and D being "Generating";
 * once every column is meshed, "Preparing the view" (uploads, compile and the reveal).
 */
export function phaseName(p: LoadProgress, uploadsDone: number, uploadsTotal: number): 'Generating' | 'Lighting' | 'Meshing' | 'Preparing the view' {
  if (p.done.T < p.needed.T || p.done.D < p.needed.D) return 'Generating';
  if (p.done.L < p.needed.L) return 'Lighting';
  if (p.done.MESH < p.needed.MESH) return 'Meshing';
  void uploadsDone; void uploadsTotal; // the uploads run after meshing, in the last phase
  return 'Preparing the view';
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function createCoordinator(o: CoordinatorOptions): { load(cx: number, cz: number, rd: number): Promise<void> } {
  const N = o.workers;
  if (!Number.isInteger(N) || N < 2) throw new RangeError(`the coordinator needs at least 2 workers, got ${N}`);
  let used = false;
  return {
    load(cx, cz, rd) {
      if (used) return Promise.reject(new Error('the coordinator loads once'));
      used = true;
      if (!Number.isInteger(rd) || rd < 0) return Promise.reject(new RangeError(`render distance ${rd} is not a non-negative integer`));
      try { assertTorusSafe(rd); } catch (e) { return Promise.reject(e); }
      return new Promise<void>((resolve, reject) => runLoad(o, N, cx, cz, rd, resolve, reject));
    },
  };
}

function runLoad(o: CoordinatorOptions, N: number, cx0: number, cz0: number, rd: number, resolve: () => void, reject: (e: unknown) => void): void {
  // Columns: the T set (a superset of the others), indexed in its spiral order.
  const offs = stageOffsets(rd);
  const n = offs.T.length;
  const cxOf = new Int32Array(n);
  const czOf = new Int32Array(n);
  const dh = new Float64Array(n);
  const keyOf = new Float64Array(n);
  const index = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const [dx, dz] = offs.T[i]!;
    cxOf[i] = cx0 + dx;
    czOf[i] = cz0 + dz;
    dh[i] = Math.sqrt(dx * dx + dz * dz);
    keyOf[i] = colKey(cx0 + dx, cz0 + dz);
    index.set(keyOf[i]!, i);
  }
  /** Bit s set when the column is in stage s's set. */
  const inSet = new Uint8Array(n);
  STAGES.forEach((st, s) => { for (const [dx, dz] of offs[st]) inSet[index.get(colKey(cx0 + dx, cz0 + dz))!]! |= 1 << s; });
  /** The 3 × 3 around each column (−1 outside the T set), the column itself included. */
  const nbr = new Int32Array(9 * n);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 9; k++) nbr[9 * i + k] = index.get(colKey(cxOf[i]! + (k % 3) - 1, czOf[i]! + Math.floor(k / 3) - 1)) ?? -1;
  }
  /** Stages reached: 0 Absent, 1 T, 2 D, 3 L, 4 MESH. */
  const state = new Uint8Array(n);
  /** 1 while the column's next job is queued or in flight. */
  const busy = new Uint8Array(n);

  const needed: Record<Stage, number> = { T: offs.T.length, D: offs.D.length, L: offs.L.length, MESH: offs.MESH.length };
  const done: Record<Stage, number> = { T: 0, D: 0, L: 0, MESH: 0 };
  let dropped = 0;
  const inFlight = [0, 0, 0, 0];
  let total = 0;
  let finished = false;

  // One binary heap of column indices per stage, ordered by (d_h, colKey): within a stage that is d_h − bonus.
  const heaps: number[][] = [[], [], [], []];
  const less = (a: number, b: number): boolean => dh[a]! < dh[b]! || (dh[a] === dh[b] && keyOf[a]! < keyOf[b]!);
  const push = (h: number[], i: number): void => {
    let c = h.length;
    h.push(i);
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (!less(h[c]!, h[p]!)) break;
      [h[c], h[p]] = [h[p]!, h[c]!];
      c = p;
    }
  };
  const pop = (h: number[]): number => {
    const top = h[0]!;
    const last = h.pop()!;
    if (h.length > 0) {
      h[0] = last;
      let c = 0;
      for (;;) {
        const l = 2 * c + 1;
        const r = l + 1;
        let m = c;
        if (l < h.length && less(h[l]!, h[m]!)) m = l;
        if (r < h.length && less(h[r]!, h[m]!)) m = r;
        if (m === c) break;
        [h[c], h[m]] = [h[m]!, h[c]!];
        c = m;
      }
    }
    return top;
  };

  /** Queues the column's next job when its column is in that stage's set and its 3 × 3 have reached the stage before. */
  const consider = (i: number): void => {
    const s = state[i]!;
    if (s >= 4 || busy[i] === 1 || (inSet[i]! & (1 << s)) === 0) return;
    if (s > 0) {
      for (let k = 0; k < 9; k++) {
        const j = nbr[9 * i + k]!;
        if (j < 0 || state[j]! < s) return;
      }
    }
    busy[i] = 1;
    push(heaps[s]!, i);
  };

  const progress = (): void => {
    o.onProgress({ needed, done: { ...done }, dropped });
  };

  const fail = (e: LoadError): void => {
    if (finished) return;
    finished = true;
    reject(e);
  };

  /** Issues ready jobs, smallest `d_h − bonus` first (ties by colKey), while a worker is free and the caps allow. */
  const pump = (): void => {
    while (!finished && total < N) {
      let best = -1;
      let bestScore = 0;
      for (let s = 0; s < 4; s++) {
        const h = heaps[s]!;
        if (h.length === 0) continue;
        if ((s === 0 && inFlight[0]! >= N - 1) || (s === 3 && inFlight[3]! >= N)) continue;
        const i = h[0]!;
        const score = dh[i]! - BONUS[s]!;
        if (best < 0 || score < bestScore || (score === bestScore && keyOf[i]! < keyOf[heaps[best]![0]!]!)) {
          best = s;
          bestScore = score;
        }
      }
      if (best < 0) return;
      issue(best, pop(heaps[best]!));
    }
  };

  const issue = (s: number, i: number): void => {
    const stage = STAGES[s]!;
    const cx = cxOf[i]!;
    const cz = czOf[i]!;
    inFlight[s]!++;
    total++;
    let job: Promise<JobOutcome>;
    try { job = o.jobs.run(stage, cx, cz); } catch (e) { job = Promise.reject(e); }
    job.then(
      (out) => { settle(s); intake(s, i, out); },
      (e: unknown) => { settle(s); fail(new LoadError(`${stage} at (${cx}, ${cz}) failed: ${errorText(e)}`, e, [cx, cz])); },
    );
  };

  const settle = (s: number): void => {
    inFlight[s]!--;
    total--;
  };

  const intake = (s: number, i: number, out: JobOutcome): void => {
    if (finished) return;
    const stage = STAGES[s]!;
    const cx = cxOf[i]!;
    const cz = czOf[i]!;
    try {
      if (stage === 'L' || stage === 'MESH') {
        const v = out.versions;
        const now = o.versionsAt(cx, cz);
        const step = stage === 'L' ? 2 : 1;
        let same = v !== null && v.length === 18 && now.length === 18;
        for (let k = 0; same && k < 18; k += step) same = v![k] === now[k];
        if (!same) {
          dropped++;
          progress();
          const got = v === null ? 'none' : `[${Array.from(v).join(', ')}]`;
          fail(new LoadError(
            `dropped result: ${stage} at (${cx}, ${cz}) recorded versions ${got}, the store's at intake are [${Array.from(now).join(', ')}]`,
            null, [cx, cz]));
          return;
        }
      }
      if (stage === 'MESH') {
        if (out.payload === null) {
          fail(new LoadError(`MESH at (${cx}, ${cz}) returned no payload`, null, [cx, cz]));
          return;
        }
        o.onMesh(out.payload);
      }
      state[i] = s + 1;
      busy[i] = 0;
      done[stage]++;
      for (let k = 0; k < 9; k++) {
        const j = nbr[9 * i + k]!;
        if (j >= 0) consider(j);
      }
      progress();
      if (done.MESH === needed.MESH) {
        finished = true;
        resolve();
        return;
      }
      pump();
    } catch (e) {
      fail(new LoadError(`${stage} at (${cx}, ${cz}): intake failed: ${errorText(e)}`, e, [cx, cz]));
    }
  };

  for (let i = 0; i < n; i++) consider(i);
  progress();
  pump();
}
