/**
 * The D skeleton (SP4a spec §3.1, §2.3, §2.5): `decorateStage` over a 3 × 3 shared store filled to T by `fillColumnT`,
 * through `fillColumnD` on the centre. With zero features the final set shares the proto slots, the final heightmaps
 * equal the proto's where they coincide, and a stop before the shares leaves the column as T committed it.
 * SP5a (spec §2.5, D21): D's diff overlay. With a diff, the final equals the proto plus the entries, the proto keeps its
 * slots and values, `REC_DIFF_FLAG` is set and the heightmaps are the final's; without one, the output is today's (a
 * fixture recorded before the overlay existed).
 */
import { beforeAll, describe, expect, test } from 'vitest';
import { STAGES } from '../../src/core/stage/registry';
import { hex64, fnv1a64Bytes } from '../../src/core/hash';
import { decorateStage } from '../../src/gen/pipeline/decorateStage';
import { writeFinalHeightmaps } from '../../src/gen/pipeline/finalHeightmaps';
import { fillColumnT } from '../../src/metrics/region';
import { NO_FLUID, WATER_SOURCE } from '../../src/world/blocks/fluid';
import { AIR, GLASS, OAK_PLANKS, STONE, TORCH } from '../../src/world/blocks/index';
import type { AuxBView, AuxView, ColumnDiff, ColumnWriter } from '../../src/world/store/api';
import { finalAt, protoAt, SECTIONS, STATUS_DECORATED, STATUS_PROTO } from '../../src/world/store/columnTable';
import { FINAL_BLOCKS, FINAL_FLUID, PROTO_BLOCKS, PROTO_FLUID } from '../../src/world/store/section';
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
    resetLight: () => { calls.push('resetLight'); },
    aux: () => { calls.push('aux'); return auxA; },
    auxB: () => { calls.push('auxB'); return null as unknown as AuxBView; },
    replaceBlocks: () => { calls.push('replaceBlocks'); },
    setDiffFlag: () => { calls.push('setDiffFlag'); },
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

/** The bytes of every aux A field, in a fixed order, hashed (FNV-1a 64, hex). */
function auxHash(a: AuxView): string {
  const fields = [a.worldSurfaceWG, a.oceanFloorWG, a.worldSurface, a.motionBlocking, a.oceanFloor, a.lightBlocking, a.surfaceBiome, a.tintTH];
  return hex64(fnv1a64Bytes(new Uint8Array(Buffer.concat(fields.map((v) => Buffer.from(v.buffer, v.byteOffset, v.byteLength))))));
}

/**
 * The centre's aux A after D without a diff, and its [blockVersion, lightVersion], recorded before SP5a's overlay
 * existed (seed '42', column (−1667, −2000)).
 */
const AUX_FIXTURE = '3074899a9d1d6735';
const VERSIONS_FIXTURE = [2, 0];

/** The proto's 24 sections of (CX, CZ): its table entries and a copy of its values. */
function protoSnapshot(s: VoxelStore): { entries: number[]; blocks: Uint16Array[]; fluid: Uint8Array[] } {
  const base = s.table.find(CX, CZ);
  const p = s.proto(CX, CZ)!;
  const entries: number[] = [];
  const blocks: Uint16Array[] = [];
  const fluid: Uint8Array[] = [];
  for (let sy = 0; sy < SECTIONS; sy++) {
    entries.push(s.table.ints[protoAt(base, sy) + PROTO_BLOCKS]!, s.table.ints[protoAt(base, sy) + PROTO_FLUID]!);
    const b = p.sectionBlocks(sy);
    const f = p.sectionFluid(sy);
    blocks.push(typeof b === 'number' ? new Uint16Array(4096).fill(b) : b.slice());
    fluid.push(typeof f === 'number' ? new Uint8Array(4096).fill(f) : f.slice());
  }
  return { entries, blocks, fluid };
}

/** Throws at the first voxel where the centre's final differs from `want(sy, idx)` (state << 8 | fluid). */
function expectFinal(s: VoxelStore, want: (sy: number, idx: number) => number): void {
  const f = s.final(CX, CZ)!;
  for (let sy = 0; sy < SECTIONS; sy++) {
    for (let idx = 0; idx < 4096; idx++) {
      const lx = idx & 15;
      const lz = (idx >> 4) & 15;
      const y = sy * 16 + (idx >> 8) - 64;
      const got = (f.block(lx, y, lz) << 8) | f.fluid(lx, y, lz);
      if (got !== want(sy, idx)) throw new Error(`final at (${lx}, ${y}, ${lz}): ${got}, expected ${want(sy, idx)}`);
    }
  }
}

describe("D's diff overlay (SP5a spec §2.5, D21)", () => {
  /** 40 entries over sections 4 (y 0 … 15), 8 (y 64 … 79, the coast's surface) and 20 (y 256 … 271, all air). */
  function diff40(): ColumnDiff {
    const values = [STONE << 8, GLASS << 8, TORCH << 8, (AIR << 8) | WATER_SOURCE, OAK_PLANKS << 8];
    const sy: number[] = [];
    const idx: number[] = [];
    const value: number[] = [];
    for (const [s, n] of [[4, 15], [8, 15], [20, 10]] as const) {
      for (let k = 0; k < n; k++) {
        sy.push(s);
        idx.push(100 + 250 * k);
        // Section 20 is air in the proto: planks there raise the column's surface.
        value.push(s === 20 ? OAK_PLANKS << 8 | NO_FLUID : values[k % values.length]!);
      }
    }
    return { sy: Uint8Array.from(sy), idx: Uint16Array.from(idx), value: Uint32Array.from(value) };
  }

  test('with a diff of 40 entries over 3 sections: the final equals proto + entries, the proto\'s slots unchanged, REC_DIFF_FLAG set, the heightmaps equal writeFinalHeightmaps over the final', () => {
    const s = filledT();
    const before = protoSnapshot(s);
    const d = diff40();
    expect(d.sy.length).toBe(40);
    expect(fillColumnD(s, ctx, CX, CZ, NEVER, d)).toBe(true);
    expect(statusOf(s, CX, CZ)).toBe(STATUS_DECORATED);
    // Blocks written, no light: blockVersion 2, lightVersion 0.
    expect(versionsOf(s)).toEqual([2, 0]);

    const entry = new Map<number, number>();
    for (let k = 0; k < d.sy.length; k++) entry.set(d.sy[k]! * 4096 + d.idx[k]!, d.value[k]!);
    expectFinal(s, (sy, idx) => entry.get(sy * 4096 + idx) ?? ((before.blocks[sy]![idx]! << 8) | before.fluid[sy]![idx]!));

    // The proto keeps its entries and values; a section the overlay replaced no longer shares the proto's slots.
    const after = protoSnapshot(s);
    expect(after.entries).toEqual(before.entries);
    for (let sy = 0; sy < SECTIONS; sy++) {
      expect(Buffer.from(after.blocks[sy]!.buffer).equals(Buffer.from(before.blocks[sy]!.buffer)), `proto blocks of ${sy}`).toBe(true);
      expect(Buffer.from(after.fluid[sy]!.buffer).equals(Buffer.from(before.fluid[sy]!.buffer)), `proto fluid of ${sy}`).toBe(true);
    }
    const base = s.table.find(CX, CZ);
    for (let sy = 0; sy < SECTIONS; sy++) {
      const overlaid = sy === 4 || sy === 8 || sy === 20;
      const pb = s.table.ints[protoAt(base, sy) + PROTO_BLOCKS]!;
      const fb = s.table.ints[finalAt(base, sy) + FINAL_BLOCKS]!;
      if (overlaid) expect(fb, `final blocks of ${sy}`).not.toBe(pb);
      else expect(fb, `final blocks of ${sy}`).toBe(pb);
      if (pb >= 0) expect(s.blockPool.refcount(pb), `proto blocks slot of ${sy}`).toBe(overlaid ? 1 : 2);
    }

    expect(s.diffFlag(CX, CZ)).toBe(true);
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) if (dx !== 0 || dz !== 0) expect(s.diffFlag(CX + dx, CZ + dz)).toBe(false);

    const f = s.final(CX, CZ)!;
    const a = f.aux()!;
    const want = recordingWriter().w.aux();
    writeFinalHeightmaps((lx, y, lz) => f.block(lx, y, lz), (lx, y, lz) => f.fluid(lx, y, lz), want);
    for (const k of ['worldSurface', 'motionBlocking', 'oceanFloor', 'lightBlocking'] as const) expect([...a[k]], k).toEqual([...want[k]]);
    // The planks at y 256 … 270 are the surface where they stand: the heightmaps read the rebuilt section.
    for (let k = 0; k < 10; k++) {
      const i = 100 + 250 * k;
      expect(a.worldSurface[i & 255], `planks ${k}`).toBe(256 + (i >> 8) + 1);
    }
  });

  test('without a diff: the final shares the proto\'s slots and the versions and aux equal today\'s (a fixture recorded before the change)', () => {
    const s = filledT();
    expect(fillColumnD(s, ctx, CX, CZ, NEVER)).toBe(true);
    const base = s.table.find(CX, CZ);
    for (let sy = 0; sy < SECTIONS; sy++) {
      expect(s.table.ints[finalAt(base, sy) + FINAL_BLOCKS], `blocks of ${sy}`).toBe(s.table.ints[protoAt(base, sy) + PROTO_BLOCKS]);
      expect(s.table.ints[finalAt(base, sy) + FINAL_FLUID], `fluid of ${sy}`).toBe(s.table.ints[protoAt(base, sy) + PROTO_FLUID]);
    }
    expect(versionsOf(s)).toEqual(VERSIONS_FIXTURE);
    expect(auxHash(s.final(CX, CZ)!.aux()!)).toBe(AUX_FIXTURE);
    expect(s.diffFlag(CX, CZ)).toBe(false);
  });

  test('a diff equal to the proto everywhere leaves the column\'s values unchanged', () => {
    const s = filledT();
    const before = protoSnapshot(s);
    const n = SECTIONS * 4096;
    const d: ColumnDiff = { sy: new Uint8Array(n), idx: new Uint16Array(n), value: new Uint32Array(n) };
    for (let k = 0; k < n; k++) {
      const sy = k >> 12;
      const idx = k & 4095;
      d.sy[k] = sy;
      d.idx[k] = idx;
      d.value[k] = (before.blocks[sy]![idx]! << 8) | before.fluid[sy]![idx]!;
    }
    expect(fillColumnD(s, ctx, CX, CZ, NEVER, d)).toBe(true);
    expectFinal(s, (sy, idx) => (before.blocks[sy]![idx]! << 8) | before.fluid[sy]![idx]!);
    expect(protoSnapshot(s).entries).toEqual(before.entries);
    expect(versionsOf(s)).toEqual(VERSIONS_FIXTURE);
    expect(auxHash(s.final(CX, CZ)!.aux()!)).toBe(AUX_FIXTURE);
    expect(s.diffFlag(CX, CZ)).toBe(true);
  });
});
