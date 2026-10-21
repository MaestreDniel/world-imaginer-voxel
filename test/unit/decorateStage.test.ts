/**
 * The D skeleton (SP4a spec §3.1, §2.3, §2.5): `decorateStage` over a 3 × 3 shared store filled to T by `fillColumnT`,
 * through `fillColumnD` on the centre. With zero features the final set shares the proto slots, the final heightmaps
 * equal the proto's where they coincide, and a stop before the shares leaves the column as T committed it.
 */
import { beforeAll, describe, expect, test } from 'vitest';
import { STAGES } from '../../src/core/stage/registry';
import { decorateStage } from '../../src/gen/pipeline/decorateStage';
import { fillColumnT } from '../../src/metrics/region';
import type { AuxBView, AuxView, ColumnWriter } from '../../src/world/store/api';
import { protoAt, SECTIONS, STATUS_DECORATED, STATUS_PROTO } from '../../src/world/store/columnTable';
import { PROTO_BLOCKS, PROTO_FLUID } from '../../src/world/store/section';
import { createStore, type VoxelStore } from '../../src/world/store/store';
import { fillColumnD } from '../../src/workers/worldJobs';
import { ctxFor } from '../harness/gen';

const MiB = 1 << 20;
const NEVER = () => false;
/** Seed '42', the COAST column of terrainStage.test.ts (sea and land mixed) and its eight neighbours. */
const ctx = ctxFor('42');
const CX = -1667;
const CZ = -2000;

/** A shared store with the 3 × 3 around (CX, CZ) committed at Proto. */
function filledT(): VoxelStore {
  const s = createStore({ shared: true, maxBlockBytes: 16 * MiB, maxByteBytes: 16 * MiB });
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) expect(fillColumnT(s, ctx, CX + dx, CZ + dz, NEVER)).toBe(true);
  }
  return s;
}

const statusOf = (s: VoxelStore, cx: number, cz: number) => s.table.status(s.table.find(cx, cz));
/** The centre's [blockVersion, lightVersion]. */
const versionsOf = (s: VoxelStore) => [...s.neighborhood(CX, CZ).versions().subarray(8, 10)];

/** Every dense proto slot of (cx, cz): [pool, slot] pairs. */
function denseProtoSlots(s: VoxelStore, cx: number, cz: number): Array<['blocks' | 'bytes', number]> {
  const base = s.table.find(cx, cz);
  const out: Array<['blocks' | 'bytes', number]> = [];
  for (let sy = 0; sy < SECTIONS; sy++) {
    const p = protoAt(base, sy);
    const b = s.table.ints[p + PROTO_BLOCKS]!;
    const f = s.table.ints[p + PROTO_FLUID]!;
    if (b >= 0) out.push(['blocks', b]);
    if (f >= 0) out.push(['bytes', f]);
  }
  return out;
}

const refcount = (s: VoxelStore, [pool, slot]: ['blocks' | 'bytes', number]) =>
  (pool === 'blocks' ? s.blockPool : s.bytePool).refcount(slot);

/** A writer that records the calls it gets and stores nothing (its aux A is a detached scratch). */
function recordingWriter(): { w: ColumnWriter; calls: string[] } {
  const calls: string[] = [];
  const h = () => new Int16Array(256);
  const auxA: AuxView = {
    worldSurfaceWG: h(), oceanFloorWG: h(), worldSurface: h(), motionBlocking: h(), oceanFloor: h(), lightBlocking: h(),
    surfaceBiome: new Uint8Array(256), tintTH: new Uint8Array(768),
  };
  const w: ColumnWriter = {
    cx: CX,
    cz: CZ,
    setProto: () => { calls.push('setProto'); },
    setFinal: () => { calls.push('setFinal'); },
    shareFinal: () => { calls.push('shareFinal'); },
    setLight: () => { calls.push('setLight'); },
    aux: () => { calls.push('aux'); return auxA; },
    auxB: () => { calls.push('auxB'); return null as unknown as AuxBView; },
    commit: () => { calls.push('commit'); },
  };
  return { w, calls };
}

describe('decorateStage and fillColumnD (SP4a spec §3.1)', () => {
  let s: VoxelStore;
  /** The number of `stop` polls of a whole run. */
  let polls = 0;
  /** The centre's status and versions after each stopped or throwing D, in order: always, at the last poll, a throw. */
  const stopped: Array<{ result: boolean | 'threw'; status: number; versions: number[] }> = [];
  let tVersions: number[] = [];

  beforeAll(() => {
    s = filledT();
    tVersions = versionsOf(s);
    const nb = s.neighborhood(CX, CZ);
    const r = recordingWriter();
    expect(decorateStage(ctx, nb, r.w, () => { polls++; return false; })).toBe(true);

    stopped.push({ result: fillColumnD(s, ctx, CX, CZ, () => true), status: statusOf(s, CX, CZ), versions: versionsOf(s) });
    let n = 0;
    stopped.push({ result: fillColumnD(s, ctx, CX, CZ, () => ++n === polls), status: statusOf(s, CX, CZ), versions: versionsOf(s) });
    let result: boolean | 'threw';
    try {
      result = fillColumnD(s, ctx, CX, CZ, () => { throw new Error('boom'); });
    } catch {
      result = 'threw';
    }
    stopped.push({ result, status: statusOf(s, CX, CZ), versions: versionsOf(s) });

    expect(fillColumnD(s, ctx, CX, CZ, NEVER)).toBe(true);
  }, 60_000);

  test('T left the centre at Proto with blockVersion 1, lightVersion 0', () => {
    expect(tVersions).toEqual([1, 0]);
  });

  test('the skeleton polls stop between steps: the nine source columns times the ten steps, then once more', () => {
    expect(polls).toBe(9 * 10 + 1);
  });

  test('a stop at the last poll (just before the shares) writes nothing', () => {
    const nb = s.neighborhood(CX, CZ);
    const r = recordingWriter();
    let n = 0;
    expect(decorateStage(ctx, nb, r.w, () => ++n === polls)).toBe(false);
    expect(r.calls).toEqual([]);
  });

  test('a stop before the shares (or a throw) leaves status 1 and the versions unchanged', () => {
    expect(stopped.map((x) => x.result)).toEqual([false, false, 'threw']);
    for (const x of stopped) {
      expect(x.status).toBe(STATUS_PROTO);
      expect(x.versions).toEqual([1, 0]);
    }
  });

  test('status 2, blockVersion 2, lightVersion 0', () => {
    expect(statusOf(s, CX, CZ)).toBe(STATUS_DECORATED);
    expect(versionsOf(s)).toEqual([2, 0]);
    // The neighbours stay at Proto, versions [1, 0].
    const v = s.neighborhood(CX, CZ).versions();
    for (let k = 0; k < 9; k++) if (k !== 4) expect([v[2 * k], v[2 * k + 1]]).toEqual([1, 0]);
  });

  test('final blocks and fluid equal proto at every voxel; the light is all zero', () => {
    const p = s.proto(CX, CZ)!;
    const f = s.final(CX, CZ)!;
    for (let sy = 0; sy < SECTIONS; sy++) {
      const pb = p.sectionBlocks(sy);
      const fb = f.sectionBlocks(sy);
      const pf = p.sectionFluid(sy);
      const ff = f.sectionFluid(sy);
      expect(typeof fb).toBe(typeof pb);
      expect(typeof ff).toBe(typeof pf);
      if (typeof pb === 'number') expect(fb).toBe(pb);
      else expect(fb).toEqual(pb);
      if (typeof pf === 'number') expect(ff).toBe(pf);
      else expect(ff).toEqual(pf);
      expect(f.sectionLight(sy)).toBe(0);
    }
    for (let lz = 0; lz < 16; lz++) {
      for (let lx = 0; lx < 16; lx++) {
        for (let y = -64; y < 320; y++) {
          if (f.block(lx, y, lz) !== p.block(lx, y, lz) || f.fluid(lx, y, lz) !== p.fluid(lx, y, lz)) {
            throw new Error(`final differs from proto at (${lx}, ${y}, ${lz})`);
          }
        }
      }
    }
  });

  test('every dense proto slot now has refcount 2 (the neighbours\' stay 1)', () => {
    const slots = denseProtoSlots(s, CX, CZ);
    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) expect(refcount(s, slot)).toBe(2);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dz === 0) continue;
        for (const slot of denseProtoSlots(s, CX + dx, CZ + dz)) expect(refcount(s, slot)).toBe(1);
      }
    }
  });

  test('worldSurface equals worldSurfaceWG and oceanFloor equals oceanFloorWG at every position (zero features)', () => {
    const a = s.final(CX, CZ)!.aux()!;
    expect([...a.worldSurface]).toEqual([...a.worldSurfaceWG]);
    expect([...a.oceanFloor]).toEqual([...a.oceanFloorWG]);
    // The coast column holds both sea and land, so the two maps differ somewhere.
    expect([...a.worldSurface]).not.toEqual([...a.oceanFloor]);
    // Until SP8a every state is air or an opaque, colliding full cube (spec §4.1), so MOTION_BLOCKING and
    // LIGHT_BLOCKING (water stops the fall) equal WORLD_SURFACE.
    expect([...a.motionBlocking]).toEqual([...a.worldSurface]);
    expect([...a.lightBlocking]).toEqual([...a.worldSurface]);
  });

  test('tintTH all 0', () => {
    expect(s.final(CX, CZ)!.aux()!.tintTH.every((v) => v === 0)).toBe(true);
  });

  test("STAGES' decorate version is 1", () => {
    expect(STAGES.find((d) => d.id === 'decorate')!.version).toBe(1);
  });
});
