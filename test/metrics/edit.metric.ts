import { expect } from 'vitest';
import { colKey, colKeyCx, colKeyCz } from '../../src/core/coords';
import { DEFAULTS } from '../../src/core/params/defaults';
import { resolveProfile } from '../../src/core/params/profiles';
import { seedFromInput } from '../../src/core/seed';
import {
  createCoordinator, createCoordinatorCounts, worldJobsOf, type StreamCamera, type StreamEvent,
} from '../../src/engine/coordinator';
import { createSimClient } from '../../src/engine/simClient';
import { createThrottle } from '../../src/engine/throttle';
import { createWorkerPool } from '../../src/engine/workerPool';
import { findSpawn } from '../../src/gen/column/spawn';
import { createGenContext } from '../../src/gen/context';
import { centreSection, createLightScratch, DEFAULT_LIGHT_TABLES, lightRegion } from '../../src/light/initial';
import { createDiffStore } from '../../src/sim/diffStore';
import { applyEdits, createEditScratch, type Edit } from '../../src/sim/edits';
import { createEditLatency } from '../../src/ui/world/editLatency';
import { createEditPath } from '../../src/ui/world/editPath';
import { createMemorySimHandler } from '../../src/workers/simHandler';
import { LAVA_SOURCE, NO_FLUID, WATER_SOURCE } from '../../src/world/blocks/fluid';
import { AIR, GLASS, ICE, OPACITY, REGISTRY, STONE, TORCH } from '../../src/world/blocks/index';
import { SECTIONS } from '../../src/world/store/columnTable';
import { copyLightRegion } from '../../src/world/store/padded';
import { createStore, type VoxelStore } from '../../src/world/store/store';
import { inProcessWorker } from '../harness/inProcessPool';
import { inProcessSimWorker } from '../harness/inProcessSim';
import { currentTier, metricTest } from '../harness/metric';
import { referenceLight } from '../harness/refs';
import { genRegion } from '../harness/region';
import { testRng } from '../harness/stats';

/**
 * L3 and E5's session part (SP5a spec §6.1, D26; master §6.4).
 *
 * - **L3** (`mismatches`, max 0): a `genRegion` upTo 'L' region (seed '42', the default profile, at the spawn; 6 × 6
 *   columns on the fast tier, 10 × 10 on quick and full, 1 thread, every proto kept) is edited through the sim's own
 *   `applyEdits` with the real relight, each edit in a column at least 2 from the region's edge, so every column of the
 *   edited 3 × 3 has its own 3 × 3 in the region. 100 seeded edits on the fast tier, 500 on quick and full: placing and
 *   breaking stone, glass, ice, torch, wall torch, a waterlogged ladder, water and lava, near the surface, deep and at
 *   y 318-319 (the above-world seed), a torch beside lava, breaks of earlier placements; plus 20 shaft cases spread over
 *   the run (a closed 5 × 4 × 5 room 13 to 36 blocks under the surface and a 1 × 1 shaft up from it to just under the
 *   surface voxel, carved in one batch; then the surface voxel broken, which opens a shaft of 12 to 35 blocks into the
 *   room; then stone placed back). After each batch, each column of each edited column's 3 × 3 is compared voxel by voxel with a
 *   fresh `copyLightRegion` and `lightRegion` (`mayEmit` true). After every 50th edit and the last, the edited column's
 *   3 × 3 is also compared with `referenceLight` over the 5 × 5-column box centred on it (the compared columns lie 16
 *   voxels from its opaque sides; light travels at most 14). `mismatches` counts the voxels that differ in either
 *   comparison. A refused batch or a shaft case that finds no enclosed place fails the test.
 * - **E5's session part** (`sessionStale`, `sessionLightMismatches`, max 0; `.out/E5.session.json`): the real
 *   coordinator (`retainAllProtos`, strict until the first fill, then `setStrict(false)`, as the page), the real pool
 *   (`createWorkerPool(2, inProcessWorker)`) and the real sim handler in process (`inProcessSimWorker`), answering
 *   after a seeded delay of 0-20 ms, with `worldJobsOf(pool, sim)` (D's read-through), on a shared store at RD 4 (fast
 *   and quick) or 6 (full), the edits posted through the page's `createEditPath` (its gate, pins and `markEdited`). A frame is one
 *   `update`, one turn of the event loop (the workers and the sim answer on timers) and the store's drain; the sink
 *   takes the payloads and draws nothing. The script: the first fill at the spawn; 20 edits near it (torches among
 *   them, some on a column border or corner), one posted per frame while the earlier ones are in flight; a teleport
 *   640 columns east (a multiple of the torus: every new T waits on an old column's record) until the edited columns'
 *   3 × 3s are freed and the disc is filled; back until filled; **the race:** an edit posted with a 20 ms reply, then
 *   the teleport in the same frame, the same way out and back; **the neighbour:** a torch on the east border of the
 *   spawn's column, then the camera rd + 5 columns west, so that the column across that border (with its two diagonal
 *   neighbours, the disc's edge being straight there) leaves keepVoxels and is freed while the torch's column stays,
 *   then back until filled, so the neighbour is regenerated beside the torch. After each return every edited voxel is
 *   read against its latest accepted value (`sessionStale` counts those that differ) and every column of each edited
 *   3 × 3 against a fresh `lightRegion` (`sessionLightMismatches` counts the voxels that differ).
 * - **Recorded:** per tier the edit and batch counts, the relight's p50 and p95 (ms, the sim's `relightMs`), the
 *   comparison time, E5's frames and its edit drops.
 */
const MiB = 1 << 20;
const TIER = currentTier();
const FAST = TIER === 'fast';
/** L3's region side, edits and shaft cases (spec §6.1). */
const L3_SIZE = FAST ? 6 : 10;
const L3_EDITS = FAST ? 100 : 500;
const L3_SHAFTS = 20;
/** The places a shaft case tries before it fails the test. */
const SHAFT_TRIES = 1000;
/** L3's `referenceLight` comparison after every this many edits (and after the last). */
const L3_REFERENCE_EVERY = 50;
/**
 * E5's render distance, edits and the teleport (spec §6.1: RD 4 on the fast tier, 6 otherwise). The quick tier runs
 * RD 4 too: the plan's prototype timing (SP5a Task 36) measured the file at 59 s on quick with RD 6, above its 50 s,
 * and the plan's first step is E5's RD on quick down to 4.
 */
const E5_RD = TIER === 'full' ? 6 : 4;
const E5_EDITS = 20;
const E5_TELEPORT_COLUMNS = 640;
/** E5's reply delay: seeded 0 … 20 ms, 20 ms for the race. */
const E5_DELAY_MAX = 20;
/** A leg that has not settled after this many frames is a stall: the run fails. */
const FRAMES_MAX = 50_000;
/** The problems listed per part. */
const PROBLEMS = 20;

const now = (): number => performance.now();
const val = (state: number, fluid = NO_FLUID): number => (state << 8) | fluid;
const valueAt = (s: VoxelStore, x: number, y: number, z: number): number => val(s.blockAt(x, y, z), s.fluidAt(x, y, z));
const set = (x: number, y: number, z: number, value: number, expectV: number): Edit => ({ x, y, z, op: 'set', value, expect: expectV });
const facings = (type: string): number[] => ['north', 'south', 'east', 'west'].map((f) => REGISTRY.parseStateKey(`${type}[facing=${f}]`));
const WALL_TORCHES = facings('wall_torch');
const LADDERS = facings('ladder');

function percentile(xs: readonly number[], p: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]!;
}

const freshScratch = createLightScratch();
const bytesOf = (a: Uint8Array): Buffer => Buffer.from(a.buffer, a.byteOffset, a.byteLength);
const uniform = (a: Uint8Array, v: number): boolean => {
  for (let i = 0; i < a.length; i++) if (a[i] !== v) return false;
  return true;
};

/**
 * Compares every column of the 3 × 3 around each of `cols` (colKeys) with a fresh `lightRegion` of it (`mayEmit` true):
 * the number of voxels whose stored light differs, the first ones described in `problems`.
 */
function freshLightMismatches(store: VoxelStore, cols: Iterable<number>, problems: string[], what: string): number {
  const scratch = freshScratch;
  const seen = new Set<number>();
  let n = 0;
  for (const k of cols) {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cx = colKeyCx(k) + dx;
        const cz = colKeyCz(k) + dz;
        const key = colKey(cx, cz);
        if (seen.has(key)) continue;
        seen.add(key);
        const f = store.final(cx, cz);
        if (f === null) {
          n += 4096 * SECTIONS;
          if (problems.length < PROBLEMS) problems.push(`${what}: column (${cx}, ${cz}) has no final set`);
          continue;
        }
        copyLightRegion(store.neighborhood(cx, cz), scratch.region);
        lightRegion(scratch, DEFAULT_LIGHT_TABLES, true);
        for (let sy = 0; sy < SECTIONS; sy++) {
          const want = centreSection(scratch, sy);
          const stored = f.sectionLight(sy);
          if (typeof stored === 'number' ? uniform(want, stored) : bytesOf(stored).equals(bytesOf(want))) continue;
          for (let i = 0; i < 4096; i++) {
            const got = typeof stored === 'number' ? stored : stored[i]!;
            if (got === want[i]) continue;
            n++;
            if (problems.length < PROBLEMS) {
              const x = 16 * cx + (i & 15);
              const z = 16 * cz + ((i >> 4) & 15);
              const y = 16 * sy - 64 + (i >> 8);
              problems.push(`${what}: (${x}, ${y}, ${z}) light ${got >> 4}/${got & 15} ≠ lightRegion ${want[i]! >> 4}/${want[i]! & 15} (sky/block)`);
            }
          }
        }
      }
    }
  }
  return n;
}

interface L3Result {
  readonly values: Record<string, number>;
  readonly problems: string[];
}

async function measureL3(): Promise<L3Result> {
  const t0 = now();
  const params = resolveProfile('default');
  const sp = findSpawn(createGenContext(seedFromInput('42'), params));
  const cx0 = (sp.x >> 4) - (L3_SIZE >> 1);
  const cz0 = (sp.z >> 4) - (L3_SIZE >> 1);
  const region = await genRegion({ seed: '42', params, cx0, cz0, w: L3_SIZE, h: L3_SIZE, upTo: 'L', order: 'spiral', threads: 1 });
  const genSeconds = (now() - t0) / 1000;
  const store = region.view.store;
  const diffs = createDiffStore();
  const scratch = createEditScratch();
  const problems: string[] = [];
  const next = testRng(0x1a3e);
  const pickInt = (n: number): number => next() % n;
  /** The columns an edit may hit: at least 2 from the region's edge. */
  const pickColumn = (): [number, number] => [cx0 + 2 + pickInt(L3_SIZE - 4), cz0 + 2 + pickInt(L3_SIZE - 4)];
  const surface = (x: number, z: number): number => store.heightAt('worldSurface', x, z)!;

  const relightMs: number[] = [];
  let mismatches = 0;
  let referenceMismatches = 0;
  let batches = 0;
  let edits = 0;
  let voxelEdits = 0;
  let refused = 0;
  let compareMs = 0;
  let referenceMs = 0;
  let referenceBoxes = 0;
  let shaftCases = 0;
  let y319 = 0;
  let torchesBesideLava = 0;
  /** The voxels placed by the random edits, which later breaks may pick. */
  const placed: Array<[number, number, number]> = [];

  /** Runs one batch, then compares the edited columns' 3 × 3s with a fresh `lightRegion`. */
  const run = (batch: readonly Edit[], what: string): void => {
    const r = applyEdits(store, diffs, scratch, batch, now);
    batches++;
    voxelEdits += batch.length;
    if (r.refused !== null) {
      refused++;
      if (problems.length < PROBLEMS) problems.push(`${what}: refused '${r.refused}'`);
      return;
    }
    if (batch.length === 1) relightMs.push(r.relightMs);
    const t = now();
    const cols = new Set(batch.map((e) => colKey(e.x >> 4, e.z >> 4)));
    mismatches += freshLightMismatches(store, cols, problems, what);
    compareMs += now() - t;
  };

  /** The edited column's 3 × 3 against `referenceLight` over the 5 × 5-column box centred on it. */
  const reference = (cx: number, cz: number, what: string): void => {
    const t = now();
    referenceBoxes++;
    const x0 = 16 * (cx - 2);
    const z0 = 16 * (cz - 2);
    const side = 80;
    const ref = referenceLight({ x0, z0, w: side, h: side }, (x, y, z) => store.blockAt(x, y, z), (x, y, z) => store.fluidAt(x, y, z));
    let n = 0;
    for (let z = z0 + 16; z < z0 + 64; z++) {
      for (let x = x0 + 16; x < x0 + 64; x++) {
        for (let y = -64; y < 320; y++) {
          const got = store.lightAt(x, y, z);
          const want = ref[((y + 64) * side + (z - z0)) * side + (x - x0)]!;
          if (got === want) continue;
          n++;
          if (problems.length < PROBLEMS) problems.push(`${what}: (${x}, ${y}, ${z}) light ${got >> 4}/${got & 15} ≠ referenceLight ${want >> 4}/${want & 15} (sky/block)`);
        }
      }
    }
    referenceMismatches += n;
    mismatches += n;
    referenceMs += now() - t;
  };

  /** A place or a break at (x, y, z): `value` written over whatever is there now. */
  const one = (x: number, y: number, z: number, value: number, what: string): void => {
    run([set(x, y, z, value, valueAt(store, x, y, z))], what);
  };

  const solid = (x: number, y: number, z: number): boolean => OPACITY[store.blockAt(x, y, z)]! === 15 && store.fluidAt(x, y, z) === NO_FLUID;

  /** A shaft case (spec §6.1): carve a closed room and a capped shaft, open the cap, close it. */
  const shaft = (): void => {
    for (let attempt = 0; attempt < SHAFT_TRIES; attempt++) {
      const [cx, cz] = pickColumn();
      const x = 16 * cx + 2 + pickInt(12);
      const z = 16 * cz + 2 + pickInt(12);
      const cap = surface(x, z) - 1;
      const roomTop = cap - 12 - pickInt(24);
      if (roomTop - 4 < -63) continue;
      // Enclosed: the room grown by one and the shaft with its cap are opaque and dry.
      let ok = solid(x, cap, z);
      for (let y = roomTop + 1; ok && y < cap; y++) ok = solid(x, y, z);
      for (let dz = -3; ok && dz <= 3; dz++) {
        for (let dx = -3; ok && dx <= 3; dx++) {
          for (let y = roomTop - 4; ok && y <= roomTop + 1; y++) ok = solid(x + dx, y, z + dz);
        }
      }
      if (!ok) continue;
      const carve: Edit[] = [];
      for (let y = roomTop - 3; y <= roomTop; y++) {
        for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) carve.push(set(x + dx, y, z + dz, val(AIR), valueAt(store, x + dx, y, z + dz)));
      }
      for (let y = roomTop + 1; y < cap; y++) carve.push(set(x, y, z, val(AIR), valueAt(store, x, y, z)));
      run(carve, `shaft ${shaftCases} at (${x}, ${cap}, ${z}): carved`);
      one(x, cap, z, val(AIR), `shaft ${shaftCases} at (${x}, ${cap}, ${z}): opened`);
      one(x, cap, z, val(STONE), `shaft ${shaftCases} at (${x}, ${cap}, ${z}): closed`);
      shaftCases++;
      return;
    }
    if (problems.length < PROBLEMS) problems.push(`shaft case ${shaftCases}: no enclosed place in ${SHAFT_TRIES} tries`);
  };

  const PLACE: ReadonlyArray<() => number> = [
    () => val(STONE), () => val(GLASS), () => val(ICE), () => val(TORCH),
    () => val(WALL_TORCHES[pickInt(4)]!), () => val(LADDERS[pickInt(4)]!, WATER_SOURCE),
    () => val(AIR, WATER_SOURCE), () => val(AIR, LAVA_SOURCE),
  ];
  const randomPlace = (): number => PLACE[pickInt(PLACE.length)]!();
  const shaftEvery = L3_EDITS / L3_SHAFTS;

  for (let n = 0; n < L3_EDITS; n++) {
    if (n % shaftEvery === 0) shaft();
    const [cx, cz] = pickColumn();
    const x = 16 * cx + pickInt(16);
    const z = 16 * cz + pickInt(16);
    const s = surface(x, z);
    const kind = pickInt(20);
    let at: [number, number] = [cx, cz];
    if (kind < 8) {
      const y = Math.min(319, s + pickInt(3));
      one(x, y, z, randomPlace(), `edit ${n}: place at (${x}, ${y}, ${z})`);
      placed.push([x, y, z]);
    } else if (kind < 13) {
      if (placed.length > 0 && pickInt(2) === 0) {
        const [px, py, pz] = placed.splice(pickInt(placed.length), 1)[0]!;
        one(px, py, pz, val(AIR), `edit ${n}: break the placed (${px}, ${py}, ${pz})`);
        at = [px >> 4, pz >> 4];
      } else {
        const y = Math.max(-64, s - 1 - pickInt(4));
        one(x, y, z, val(AIR), `edit ${n}: break at (${x}, ${y}, ${z})`);
      }
    } else if (kind < 15) {
      const y = -60 + pickInt(Math.max(1, s + 60));
      const value = pickInt(2) === 0 ? val(AIR) : randomPlace();
      one(x, y, z, value, `edit ${n}: deep at (${x}, ${y}, ${z})`);
    } else if (kind < 17) {
      const y = 318 + pickInt(2);
      y319++;
      one(x, y, z, pickInt(3) === 0 ? val(AIR) : randomPlace(), `edit ${n}: top at (${x}, ${y}, ${z})`);
    } else {
      // A torch beside lava: lava first, then the torch beside it in the same column: east of it, or west on the
      // column's east edge.
      const lx = x - 16 * cx;
      const tx = lx === 15 ? x - 1 : x + 1;
      const y = Math.min(319, s);
      one(x, y, z, val(AIR, LAVA_SOURCE), `edit ${n}: lava at (${x}, ${y}, ${z})`);
      one(tx, y, z, val(TORCH), `edit ${n}: torch beside lava at (${tx}, ${y}, ${z})`);
      torchesBesideLava++;
    }
    edits++;
    if ((n + 1) % L3_REFERENCE_EVERY === 0 || n === L3_EDITS - 1) reference(at[0], at[1], `edit ${n}: referenceLight`);
  }

  return {
    problems,
    values: {
      mismatches,
      referenceMismatches,
      edits,
      batches,
      voxelEdits,
      refused,
      shaftCases,
      shaftsMissing: L3_SHAFTS - shaftCases,
      editsAtTop: y319,
      torchesBesideLava,
      referenceBoxes,
      relightP50Ms: percentile(relightMs, 0.5),
      relightP95Ms: percentile(relightMs, 0.95),
      compareSeconds: Math.round(compareMs) / 1000,
      referenceSeconds: Math.round(referenceMs) / 1000,
      genSeconds: Math.round(genSeconds * 1000) / 1000,
      seconds: Math.round(now() - t0) / 1000,
    },
  };
}

const turn = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

interface E5Result {
  readonly values: Record<string, number>;
  readonly problems: string[];
}

async function measureE5(): Promise<E5Result> {
  const t0 = now();
  const store = createStore({ shared: true, maxBlockBytes: 256 * MiB, maxByteBytes: 256 * MiB });
  const pool = createWorkerPool(2, inProcessWorker, { epochCells: store.epochs.cells, onWorkerDead: (t) => store.markDead(t) });
  const delays = testRng(0xe5);
  /** The race's delay, while set. */
  let forced: number | null = null;
  const delay = (): number => forced ?? delays() % (E5_DELAY_MAX + 1);
  let simFailure: Error | null = null;
  const sim = createSimClient(() => inProcessSimWorker(createMemorySimHandler(), delay), { onFailure(e) { simFailure = e; } });
  const problems: string[] = [];
  const events: StreamEvent[] = [];
  let frames = 0;
  let checks = 0;
  let sessionStale = 0;
  let sessionLightMismatches = 0;
  let refusedEdits = 0;
  let compareMs = 0;
  let disposeCoordinator = (): void => {};
  try {
    await pool.attachStore(store.handles());
    expect((await pool.configure('42', DEFAULTS)).type).toBe('ready');
    await sim.attach(store.handles());
    const spawn = await pool.spawn();
    const coordinator = createCoordinator({
      jobs: worldJobsOf(pool, sim),
      store,
      // The sink takes the payloads and draws nothing: E5 reads the store.
      sink: { stage() {}, unstage: () => false, remove() {} },
      throttle: createThrottle({ max: Math.max(1, pool.size - 1) }),
      rd: E5_RD,
      rdMax: E5_RD,
      retainAllProtos: true,
      strict: true,
      generation: pool.epoch,
      epoch: 1,
      onEvent: (e) => { events.push(e); },
    });
    disposeCoordinator = () => coordinator.dispose();
    const path = createEditPath({ sim, coordinator, latency: createEditLatency(), now, notices: { show() {} } });

    const C0: [number, number] = [Math.floor(spawn.x / 16), Math.floor(spawn.z / 16)];
    let cam: StreamCamera = { x: C0[0] * 16 + 8, z: C0[1] * 16 + 8, yawDeg: 0 };
    const moveTo = (cx: number, cz: number): void => { cam = { x: cx * 16 + 8, z: cz * 16 + 8, yawDeg: 0 }; };
    const frame = async (): Promise<void> => {
      coordinator.update(cam);
      await turn();
      const e = events.find((x) => x.kind !== 'skipped') ?? events[0];
      if (e !== undefined) throw new Error(`E5: ${e.kind === 'fatal' ? `fatal: ${e.message}` : e.kind === 'skipped' ? `skipped (${e.cx}, ${e.cz})` : `storeFull (lower to ${e.lowerRd})`}`);
      if (simFailure !== null) throw new Error(`E5: ${(simFailure as Error).message}`);
      store.drain();
      frames++;
    };
    const until = async (done: () => boolean, what: string): Promise<void> => {
      for (let i = 0; i < FRAMES_MAX; i++) {
        await frame();
        if (done()) return;
      }
      throw new Error(`E5: ${what}: not settled after ${FRAMES_MAX} frames`);
    };

    /** The latest accepted value of each edited voxel ("x,y,z" → value). */
    const latest = new Map<string, number>();
    /** The edited columns (colKeys). */
    const edited = new Set<number>();
    /** Posts one edit through the page's path; its outcome recorded when it comes. */
    const post = (x: number, y: number, z: number, value: number, what: string): Promise<void> => {
      const e = set(x, y, z, value, valueAt(store, x, y, z));
      return path.post([e]).then((o) => {
        if (o.ok) {
          latest.set(`${x},${y},${z}`, value);
          edited.add(colKey(x >> 4, z >> 4));
        } else {
          refusedEdits++;
          if (problems.length < PROBLEMS) problems.push(`${what} at (${x}, ${y}, ${z}): refused '${o.why}'`);
        }
      });
    };
    /** Every edited voxel against its latest value, every edited 3 × 3 against a fresh `lightRegion`. */
    const check = (what: string): void => {
      checks++;
      for (const [k, v] of latest) {
        const [x, y, z] = k.split(',').map(Number) as [number, number, number];
        const got = valueAt(store, x, y, z);
        if (got === v) continue;
        sessionStale++;
        if (problems.length < PROBLEMS) problems.push(`${what}: (${x}, ${y}, ${z}) reads ${got >> 8}/${got & 255} ≠ its latest ${v >> 8}/${v & 255} (state/fluid)`);
      }
      const t = now();
      sessionLightMismatches += freshLightMismatches(store, edited, problems, what);
      compareMs += now() - t;
    };
    /** The edited columns' 3 × 3s all left the store (their records freed or taken by the columns 640 east). */
    const oldPlaceFreed = (): boolean => {
      for (const k of edited) {
        for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) if (store.holder(colKeyCx(k) + dx, colKeyCz(k) + dz) === 'self') return false;
      }
      return true;
    };
    /** Out 640 columns east until the old place is freed and the disc filled, then back until filled. */
    const outAndBack = async (what: string): Promise<void> => {
      await until(() => !path.pending() && oldPlaceFreed() && coordinator.firstFill(), `${what}: the teleport`);
      moveTo(C0[0], C0[1]);
      await until(() => coordinator.firstFill(), `${what}: back`);
    };

    // The first fill at the spawn (strict), then the page's setting.
    await until(() => coordinator.firstFill(), 'the first fill');
    coordinator.setStrict(false);

    // 20 edits near the spawn, one posted per frame: torches among them, some on a column border or a corner.
    const next = testRng(0x5e55);
    const kinds: ReadonlyArray<() => number> = [
      () => val(TORCH), () => val(STONE), () => val(GLASS), () => val(AIR), () => val(TORCH), () => val(ICE),
      () => val(WALL_TORCHES[next() % 4]!), () => val(LADDERS[next() % 4]!, WATER_SOURCE), () => val(AIR, WATER_SOURCE), () => val(TORCH),
    ];
    const BORDER = [0, 15];
    const pending: Array<Promise<void>> = [];
    const taken = new Set<string>();
    for (let n = 0; pending.length < E5_EDITS; n++) {
      const cx = C0[0] - 1 + (next() % 3);
      const cz = C0[1] - 1 + (next() % 3);
      // Every third on a border, every sixth on a corner.
      const lx = n % 3 === 0 ? BORDER[next() % 2]! : next() % 16;
      const lz = n % 6 === 0 ? BORDER[next() % 2]! : next() % 16;
      const x = 16 * cx + lx;
      const z = 16 * cz + lz;
      const kind = kinds[n % kinds.length]!;
      const s = store.heightAt('worldSurface', x, z)!;
      const value = kind();
      const y = value === val(AIR) ? s - 1 : s;
      if (taken.has(`${x},${y},${z}`)) continue;
      taken.add(`${x},${y},${z}`);
      pending.push(post(x, y, z, value, `edit ${n}`));
      await frame();
    }
    await until(() => !path.pending(), 'the edits\' replies');
    await Promise.all(pending);
    check('after the edits');

    // The teleport and back.
    moveTo(C0[0] + E5_TELEPORT_COLUMNS, C0[1]);
    await outAndBack('the teleport');
    check('after the teleport and back');

    // The race: an edit with a 20 ms reply, then the teleport in the same frame.
    {
      const x = 16 * C0[0] + 7;
      const z = 16 * C0[1] + 7;
      const y = store.heightAt('worldSurface', x, z)!;
      forced = E5_DELAY_MAX;
      const raced = post(x, y, z, val(TORCH), 'the race');
      forced = null;
      moveTo(C0[0] + E5_TELEPORT_COLUMNS, C0[1]);
      await outAndBack('the race');
      await raced;
      expect(latest.get(`${x},${y},${z}`), 'the race\'s edit was accepted').toBe(val(TORCH));
      check('after the race');
    }

    // The neighbour: a torch on the east border of the spawn's column; the column east of it leaves keepVoxels alone
    // (with its diagonal neighbours) and is regenerated beside the torch.
    let neighbourRegenerated = 0;
    {
      const x = 16 * C0[0] + 15;
      const z = 16 * C0[1] + 8;
      const y = store.heightAt('worldSurface', x, z)!;
      const placedTorch = post(x, y, z, val(TORCH), 'the neighbour\'s torch');
      await until(() => !path.pending(), 'the neighbour\'s torch');
      await placedTorch;
      moveTo(C0[0] - (E5_RD + 5), C0[1]);
      await until(() => store.holder(C0[0] + 1, C0[1]) !== 'self', 'the neighbour freed');
      expect(store.holder(C0[0], C0[1]), 'the torch\'s column stays').toBe('self');
      for (const [dx, dz] of [[-1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]] as const) {
        expect(store.holder(C0[0] + dx, C0[1] + dz), `(${dx}, ${dz}) of the torch's 3 × 3 stays`).toBe('self');
      }
      moveTo(C0[0], C0[1]);
      await until(() => coordinator.firstFill(), 'the neighbour: back');
      if (store.holder(C0[0] + 1, C0[1]) === 'self' && store.final(C0[0] + 1, C0[1]) !== null) neighbourRegenerated = 1;
      check('after the neighbour');
    }

    const counts = coordinator.counts(createCoordinatorCounts());
    expect([counts.failed, counts.storeFull], 'failed columns, StoreFull errors').toEqual([0, 0]);
    coordinator.dispose();
    disposeCoordinator = () => {};
    return {
      problems,
      values: {
        sessionStale,
        sessionLightMismatches,
        edits: latest.size,
        refusedEdits,
        checks,
        neighbourRegenerated,
        frames,
        editDropped: counts.editDropped,
        dropped: counts.dropped,
        compareSeconds: Math.round(compareMs) / 1000,
        seconds: Math.round(now() - t0) / 1000,
      },
    };
  } finally {
    disposeCoordinator();
    sim.dispose();
    pool.terminate();
  }
}

metricTest('L3', ['mismatches'], async () => {
  const m = await measureL3();
  expect.soft(m.problems, `L3 (tier ${TIER}): first ${PROBLEMS} problems of ${m.values.mismatches} mismatches, ${m.values.refused} refusals, ${m.values.shaftsMissing} shafts missing`).toEqual([]);
  return m.values;
});

metricTest('E5', ['sessionStale', 'sessionLightMismatches'], async () => {
  const m = await measureE5();
  expect.soft(m.problems, `E5's session part (tier ${TIER}): first ${PROBLEMS} problems`).toEqual([]);
  expect.soft(m.values.neighbourRegenerated, 'the neighbour was regenerated').toBe(1);
  return m.values;
}, 600_000, { outName: 'E5.session' });
