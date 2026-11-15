/**
 * The hover readout (SP2a spec §6.3; SP2b spec §2.5, §6.3): a ColumnPoint as text, read with one point job
 * at a time (latest wins). Outside the half-open world window [−2^19, 2^19) it shows "outside the world
 * window" and sends no job (SP2a minors 1 and 2). It shows points of the pool's current epoch only: a job
 * a configure superseded is sent again, and refresh() re-reads the last position after a new source.
 * While the map shows the caveBiome layer the job carries the map's `caveY` and the readout ends with the worker's
 * cave-biome line (SP6b spec §9.1, Spec correction 24: the picker's noises live in the worker's GenContext).
 */
import { CAVE_BIOME_NAMES } from '../../core/constants';
import { JobCancelled, type PointReply } from '../../engine/workerPool';
import { biomeName } from '../../gen/biomes/registry';
import { pointInWindow, type PointCaveBiome } from '../../workers/protocol';
import { caveYOf, type MapView } from './mapState';

const n = (v: number, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : v > 0 ? '+∞' : v < 0 ? '−∞' : 'NaN');

/** "cave biome at y n: lush (depth 0.42)"; above the ground (id 255) "cave biome at y n: none (above the ground)". */
export function caveBiomeLine(y: number, c: PointCaveBiome): string {
  const name = CAVE_BIOME_NAMES[c.id];
  return `cave biome at y ${y}: ${name === undefined ? 'none (above the ground)' : `${name} (depth ${n(c.depth, 2)})`}`;
}

/** The point as text; with the y its job was sent at and the reply's `caveBiome`, the cave-biome line last. */
export function formatPoint(p: PointReply, y?: number): string {
  const lines = [
    `x ${n(p.x, 1)}  z ${n(p.z, 1)}`,
    `biome ${biomeName(p.biome)}`,
    `C ${n(p.C)}  E ${n(p.E)}  W ${n(p.W)}`,
    `T ${n(p.T)}  H ${n(p.H)}  R ${n(p.R)}  PV ${n(p.PV)}`,
    `offset0 ${n(p.offset0, 2)}  σ0 ${n(p.sigma0, 2)}  jag0 ${n(p.jag0, 2)}`,
    `steep ${n(p.steep, 3)}`,
    `riverDist ${n(p.riverDist, 1)}  strength ${n(p.riverStrength, 2)}${p.riverWet ? '  river' : ''}${p.gorge ? '  gorge' : ''}`,
    `lake ${n(p.lakeMask, 2)}  level ${n(p.lakeLevel, 0)}  floor ${n(p.lakeFloor, 1)}`,
    `offset ${n(p.offset, 2)}  σ ${n(p.sigma, 2)}  jag ${n(p.jag, 2)}`,
    `surfaceEst ${n(p.surfaceEst, 2)}  water ${n(p.surfaceWaterLevel, 0)}`,
  ];
  if (y !== undefined && p.caveBiome !== undefined) lines.push(caveBiomeLine(y, p.caveBiome));
  return lines.join('\n');
}

export const OUTSIDE_WINDOW = 'outside the world window';

/** The pool's point job (WorkerPool satisfies it); `y` asks for the cave biome there too (ruling P49). */
export interface HoverPool {
  point(x: number, z: number, priority?: number, y?: number): Promise<PointReply>;
}

export interface HoverReadout {
  /** The pointer is over block position (x, z). */
  move(x: number, z: number): void;
  /** Re-reads the last position inside the window (call it when the canvas shows a new source). */
  refresh(): void;
  /** A job that settles later shows nothing and sends nothing; later calls do nothing (SP4c spec §1.2). */
  dispose(): void;
}

/** `view` is read at each job: its `caveYOf` (the caveBiome layer's y, else none) goes with the job. */
export function createHoverReadout(pool: HoverPool, show: (text: string) => void, view: () => Pick<MapView, 'layer' | 'caveY'>): HoverReadout {
  let busy = false;
  /** The position waiting for the job in flight (latest wins). */
  let next: readonly [number, number] | null = null;
  /** The pointer's last position inside the window; null once it left the window. */
  let last: readonly [number, number] | null = null;
  let disposed = false;

  const run = (x: number, z: number) => {
    busy = true;
    const y = caveYOf(view());
    pool.point(x, z, undefined, y).then((p) => {
      if (!disposed && last !== null) show(formatPoint(p, y));
    }, (e: unknown) => {
      if (disposed) return;
      if (!(e instanceof JobCancelled)) show(String(e));
      else if (next === null) next = last;
    }).finally(() => {
      busy = false;
      if (disposed || next === null) return;
      const [a, b] = next;
      next = null;
      run(a, b);
    });
  };

  const move = (x: number, z: number) => {
    if (disposed) return;
    if (!pointInWindow(x, z)) {
      last = null;
      next = null;
      show(OUTSIDE_WINDOW);
      return;
    }
    last = [x, z];
    if (busy) next = last;
    else run(x, z);
  };

  return {
    move,
    refresh() { if (last !== null) move(last[0], last[1]); },
    dispose() {
      disposed = true;
      last = null;
      next = null;
    },
  };
}
