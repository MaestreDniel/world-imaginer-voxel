/**
 * The column mesh payload (SP4a spec §5.1, §5.7, §5.8; rulings P24, P26, P27): `meshColumnPayload` over a real
 * neighbourhood, a 3 × 3 of seed '42' filled to Published (T on the 7 × 7, D on the 5 × 5, L on the 3 × 3), and
 * `meshColumnJob`'s Published check. The payload is checked against `meshSolid`/`meshFluid` run per section by hand,
 * its trivial sections against the descriptors, its spheres against their vertices, its east seam against the east
 * neighbour's voxels, and its buffers for ownership.
 */
import { beforeAll, describe, expect, test } from 'vitest';
import { createLightScratch } from '../../src/light/initial';
import { fillColumnT } from '../../src/metrics/region';
import { createMeshBuilder } from '../../src/mesh/builder';
import {
  createMeshScratch,
  isTrivial,
  meshColumnPayload,
  payloadProblem,
  ROW_INTS,
  type ColumnMeshPayload,
  type MeshScratch,
} from '../../src/mesh/column';
import { connectivity15 } from '../../src/mesh/connectivity';
import { fluidDepths, meshFluid } from '../../src/mesh/fluid';
import { meshSolid, type MeshOptions } from '../../src/mesh/greedy';
import { unpackFluid, unpackSolid } from '../../src/mesh/packing';
import { FLUID_WATER, fluidType } from '../../src/world/blocks/fluid';
import { AIR, FULL_FACES, PASS } from '../../src/world/blocks/index';
import { FACE_EAST, FACE_WEST, PASS_OPAQUE } from '../../src/world/blocks/kinds';
import type { NeighborhoodReader } from '../../src/world/store/api';
import { SECTIONS, STATUS_DECORATED } from '../../src/world/store/columnTable';
import { copyPaddedSection, createPaddedSection } from '../../src/world/store/padded';
import { createStore, type VoxelStore } from '../../src/world/store/store';
import { fillColumnD, fillColumnL, meshColumnJob } from '../../src/workers/worldJobs';
import { ctxFor } from '../harness/gen';

const MiB = 1 << 20;
const NEVER = () => false;
/**
 * Seed '42', the west neighbour of terrainStage.test.ts's OVERHANG column: water in the column (water rows) and a stepped
 * east seam (17 opaque voxels at x = 15 against air at the east neighbour's x = 0), so the seam check is not vacuous.
 */
const ctx = ctxFor('42');
const CX = -1239;
const CZ = -2000;
const MEDIUM: MeshOptions = { ao: true, smoothLight: true };
const ALL_PAIRS = 0x7FFF;

/** A shared store with T on the 7 × 7 around (CX, CZ), D on the 5 × 5 and L on the 3 × 3: the centre's 3 × 3 is Published. */
function filledL(): VoxelStore {
  const s = createStore({ shared: true, maxBlockBytes: 64 * MiB, maxByteBytes: 64 * MiB });
  for (let dz = -3; dz <= 3; dz++) {
    for (let dx = -3; dx <= 3; dx++) expect(fillColumnT(s, ctx, CX + dx, CZ + dz, NEVER)).toBe(true);
  }
  for (let dz = -2; dz <= 2; dz++) {
    for (let dx = -2; dx <= 2; dx++) expect(fillColumnD(s, ctx, CX + dx, CZ + dz, NEVER)).toBe(true);
  }
  const light = createLightScratch();
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) expect(fillColumnL(s, CX + dx, CZ + dz, light, NEVER)).not.toBeNull();
  }
  return s;
}

/** The rows of a payload as objects. */
interface Row { sy: number; pass: number; vertexStart: number; vertexCount: number; indexStart: number; indexCount: number; r: number }
function rowsOf(p: ColumnMeshPayload): Row[] {
  const out: Row[] = [];
  for (let r = 0; r < p.rows.length / ROW_INTS; r++) {
    const o = r * ROW_INTS;
    out.push({
      sy: p.rows[o]!, pass: p.rows[o + 1]!, vertexStart: p.rows[o + 2]!, vertexCount: p.rows[o + 3]!,
      indexStart: p.rows[o + 4]!, indexCount: p.rows[o + 5]!, r,
    });
  }
  return out;
}

/** Every array of a payload, by name. */
const arraysOf = (p: ColumnMeshPayload) => ({
  versions: p.versions, connectivity: p.connectivity, position: p.position, data: p.data, index: p.index, rows: p.rows,
  spheres: p.spheres,
});

/** A byte copy of each of a payload's arrays. */
const snapshot = (p: ColumnMeshPayload): Uint8Array[] =>
  Object.values(arraysOf(p)).map((a) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength).slice());

/** Per section, the hand-run mesh: the builder's three passes and connectivity15 (ruling P24's `fluidDepths`). */
function handMesh(nb: NeighborhoodReader, sy: number, o: MeshOptions) {
  const padded = createPaddedSection();
  const builder = createMeshBuilder();
  const depth = new Uint8Array(4096);
  copyPaddedSection(nb, sy, padded);
  meshSolid(padded, o, builder);
  fluidDepths(nb, sy, depth);
  meshFluid(padded, depth, builder);
  return { builder, connectivity: connectivity15(padded) };
}

describe('meshColumnPayload on a Published 3 × 3 (SP4a spec §5.8)', () => {
  let store: VoxelStore;
  let nb: NeighborhoodReader;
  let scratch: MeshScratch;
  let p: ColumnMeshPayload;

  beforeAll(() => {
    store = filledL();
    nb = store.neighborhood(CX, CZ);
    scratch = createMeshScratch();
    p = meshColumnPayload(nb, scratch, MEDIUM);
  });

  test('payloadProblem is null, and the payload is the centre column', () => {
    expect(payloadProblem(p)).toBeNull();
    expect([p.cx, p.cz]).toEqual([CX, CZ]);
    expect(p.rows.length).toBeGreaterThan(0);
  });

  test('versions equals the 3 × 3 versions', () => {
    expect([...p.versions]).toEqual([...nb.versions()]);
    expect(p.versions.length).toBe(18);
  });

  test('every row\'s sphere contains its vertices', () => {
    for (const row of rowsOf(p)) {
      const [x, y, z, r] = [...p.spheres.subarray(4 * row.r, 4 * row.r + 4)] as [number, number, number, number];
      for (let v = row.vertexStart; v < row.vertexStart + row.vertexCount; v++) {
        const dx = p.position[4 * v]! / 8 - x;
        const dy = p.position[4 * v + 1]! / 8 - y;
        const dz = p.position[4 * v + 2]! / 8 - z;
        expect(Math.sqrt(dx * dx + dy * dy + dz * dz)).toBeLessThanOrEqual(r);
      }
    }
  });

  test('the sphere is centred on the row\'s AABB with the half diagonal as radius', () => {
    for (const row of rowsOf(p)) {
      const lo = [Infinity, Infinity, Infinity];
      const hi = [-Infinity, -Infinity, -Infinity];
      for (let v = row.vertexStart; v < row.vertexStart + row.vertexCount; v++) {
        for (let a = 0; a < 3; a++) {
          lo[a] = Math.min(lo[a]!, p.position[4 * v + a]! / 8);
          hi[a] = Math.max(hi[a]!, p.position[4 * v + a]! / 8);
        }
      }
      const s = p.spheres.subarray(4 * row.r, 4 * row.r + 4);
      for (let a = 0; a < 3; a++) expect(s[a]).toBe((lo[a]! + hi[a]!) / 2);
      expect(s[3]).toBeCloseTo(Math.hypot(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!) / 2, 5);
    }
  });

  test('sections above the terrain are trivial: no rows, connectivity 0x7FFF', () => {
    // The highest section that is not uniform air in any column of the 3 × 3.
    let top = -1;
    for (let sy = 0; sy < SECTIONS; sy++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) if (nb.final(dx, dz)!.sectionBlocks(sy) !== AIR) top = Math.max(top, sy);
      }
    }
    expect(top + 2).toBeLessThan(SECTIONS);
    const withRows = new Set(rowsOf(p).map((r) => r.sy));
    for (let sy = top + 2; sy < SECTIONS; sy++) {
      expect(isTrivial(nb, sy), `sy ${sy}`).toBe(1);
      expect(withRows.has(sy), `sy ${sy}`).toBe(false);
      expect(p.connectivity[sy], `sy ${sy}`).toBe(ALL_PAIRS);
    }
  });

  test('the bedrock floor (ruling P26): sy 2 is trivial opaque, sy 0, 1 and 3 are not; sy 0-3 have no rows and connectivity 0', () => {
    expect(isTrivial(nb, 2)).toBe(2);
    for (const sy of [0, 1, 3]) expect(isTrivial(nb, sy), `sy ${sy}`).toBe(0);
    const withRows = new Set(rowsOf(p).map((r) => r.sy));
    for (const sy of [0, 1, 2, 3]) {
      expect(withRows.has(sy), `sy ${sy}`).toBe(false);
      expect(p.connectivity[sy], `sy ${sy}`).toBe(0);
    }
  });

  test('isTrivial agrees with the descriptors: 1 and 2 only where the section and its six neighbours are uniform', () => {
    const c = nb.final(0, 0)!;
    for (let sy = 0; sy < SECTIONS; sy++) {
      const t = isTrivial(nb, sy);
      if (t === 0) continue;
      const own = c.sectionBlocks(sy);
      expect(typeof own, `sy ${sy}`).toBe('number');
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        expect(typeof nb.final(dx, dz)!.sectionBlocks(sy), `sy ${sy} (${dx}, ${dz})`).toBe('number');
      }
      if (t === 1) {
        expect(own).toBe(AIR);
        expect(c.sectionFluid(sy)).toBe(0);
      } else {
        expect(PASS[own as number]).toBe(PASS_OPAQUE);
        expect(FULL_FACES[own as number]).toBe(63);
      }
    }
  });

  test('the payload equals meshSolid/meshFluid run per section by hand; trivial sections mesh to nothing', () => {
    const rows = rowsOf(p);
    let vertexEnd = 0;
    let indexEnd = 0;
    for (let sy = 0; sy < SECTIONS; sy++) {
      const hand = handMesh(nb, sy, MEDIUM);
      expect(p.connectivity[sy], `sy ${sy}`).toBe(hand.connectivity);
      for (const pass of [0, 1, 2] as const) {
        const v = hand.builder.view(pass);
        const row = rows.find((r) => r.sy === sy && r.pass === pass);
        if (v.indices === 0) {
          expect(row, `sy ${sy} pass ${pass}`).toBeUndefined();
          continue;
        }
        expect(isTrivial(nb, sy), `sy ${sy}`).toBe(0);
        expect(row, `sy ${sy} pass ${pass}`).toBeDefined();
        // Rows are in (sy, pass) order and pack the buffers back to back.
        expect(row!.vertexStart).toBe(vertexEnd);
        expect(row!.indexStart).toBe(indexEnd);
        expect(row!.vertexCount).toBe(v.vertices);
        expect(row!.indexCount).toBe(v.indices);
        expect([...p.position.subarray(4 * row!.vertexStart, 4 * (row!.vertexStart + row!.vertexCount))]).toEqual([...v.position]);
        expect([...p.data.subarray(row!.vertexStart, row!.vertexStart + row!.vertexCount)]).toEqual([...v.data]);
        expect([...p.index.subarray(row!.indexStart, row!.indexStart + row!.indexCount)]).toEqual([...v.index]);
        vertexEnd += v.vertices;
        indexEnd += v.indices;
      }
    }
    expect(vertexEnd).toBe(p.data.length);
    expect(4 * vertexEnd).toBe(p.position.length);
    expect(indexEnd).toBe(p.index.length);
  });

  test('the payload has water rows (pass 2) and opaque rows (pass 0)', () => {
    const passes = new Set(rowsOf(p).map((r) => r.pass));
    expect(passes.has(0)).toBe(true);
    expect(passes.has(2)).toBe(true);
  });

  test('seam: the faces on the column\'s x = 16 plane are exactly the east faces of x = 15 against air of the east neighbour', () => {
    const centre = nb.final(0, 0)!;
    const east = nb.final(1, 0)!;
    const meshed = { solid: [] as string[], water: [] as string[] };
    for (const row of rowsOf(p)) {
      const y0 = 16 * row.sy - 64;
      for (let i = row.indexStart; i < row.indexStart + row.indexCount; i += 6) {
        // A quad's four distinct vertices: the first triangle and the other vertex of the second.
        const vs = new Set([...p.index.subarray(i, i + 6)].map((k) => row.vertexStart + k));
        const corners = [...vs].map((v) => [p.position[4 * v]!, p.position[4 * v + 1]!, p.position[4 * v + 2]!]);
        if (!corners.every((c) => c[0] === 128)) continue;
        const word = p.data[[...vs][0]!]!;
        const face = row.pass === 2 ? unpackFluid(word).face : unpackSolid(word).face;
        expect(face).toBe(FACE_EAST);
        const ys = corners.map((c) => c[1]! / 8);
        const zs = corners.map((c) => c[2]! / 8);
        for (let y = Math.min(...ys); y < Math.max(...ys); y++) {
          for (let z = Math.min(...zs); z < Math.max(...zs); z++) {
            // The east neighbour's voxel the face looks at is air (and, for water, holds no water).
            expect(east.block(0, y0 + y, z)).toBe(AIR);
            if (row.pass === 2) expect(fluidType(east.fluid(0, y0 + y, z))).not.toBe(FLUID_WATER);
            (row.pass === 2 ? meshed.water : meshed.solid).push(`${y0 + y},${z}`);
          }
        }
      }
    }
    // The brute-force east faces of x = 15: an opaque voxel against an air block, a water voxel against air without water.
    const brute = { solid: [] as string[], water: [] as string[] };
    for (let y = -64; y < 320; y++) {
      for (let z = 0; z < 16; z++) {
        const s = centre.block(15, y, z);
        const n = east.block(0, y, z);
        if (n !== AIR) continue;
        if (PASS[s] === PASS_OPAQUE) brute.solid.push(`${y},${z}`);
        if (fluidType(centre.fluid(15, y, z)) === FLUID_WATER && fluidType(east.fluid(0, y, z)) !== FLUID_WATER) {
          brute.water.push(`${y},${z}`);
        }
      }
    }
    expect(brute.solid.length).toBeGreaterThan(0);
    expect(meshed.solid.sort()).toEqual(brute.solid.sort());
    expect(meshed.water.sort()).toEqual(brute.water.sort());
  });

  test('no face on the x = 0 plane faces west into a non-air voxel of the west neighbour', () => {
    const west = nb.final(-1, 0)!;
    for (const row of rowsOf(p)) {
      const y0 = 16 * row.sy - 64;
      for (let i = row.indexStart; i < row.indexStart + row.indexCount; i += 6) {
        const vs = [...new Set([...p.index.subarray(i, i + 6)].map((k) => row.vertexStart + k))];
        if (!vs.every((v) => p.position[4 * v] === 0)) continue;
        const word = p.data[vs[0]!]!;
        expect(row.pass === 2 ? unpackFluid(word).face : unpackSolid(word).face).toBe(FACE_WEST);
        const ys = vs.map((v) => p.position[4 * v + 1]! / 8);
        const zs = vs.map((v) => p.position[4 * v + 2]! / 8);
        for (let y = Math.min(...ys); y < Math.max(...ys); y++) {
          for (let z = Math.min(...zs); z < Math.max(...zs); z++) expect(west.block(15, y0 + y, z)).toBe(AIR);
        }
      }
    }
  });

  test('ruling P27: seven fresh, exact, unshared buffers that alias no scratch', () => {
    const arrays = Object.values(arraysOf(p));
    const buffers = arrays.map((a) => a.buffer);
    for (const [name, a] of Object.entries(arraysOf(p))) {
      expect(a.byteOffset, name).toBe(0);
      expect(a.byteLength, name).toBe(a.buffer.byteLength);
      expect(a.buffer instanceof SharedArrayBuffer, name).toBe(false);
    }
    expect(new Set(buffers).size).toBe(7);
    const scratchBuffers = new Set<ArrayBufferLike>([
      scratch.padded.blocks.buffer, scratch.padded.light.buffer, scratch.padded.fluid.buffer, scratch.depth.buffer,
      scratch.column.position.buffer, scratch.column.data.buffer, scratch.column.index.buffer, scratch.column.rows.buffer,
      scratch.column.spheres.buffer,
      ...([0, 1, 2] as const).flatMap((k) => {
        const v = scratch.builder.view(k);
        return [v.position.buffer, v.data.buffer, v.index.buffer];
      }),
    ]);
    for (const b of buffers) expect(scratchBuffers.has(b)).toBe(false);
  });

  test('ruling P27: a second call on the same scratch leaves the first payload byte-identical', () => {
    const first = meshColumnPayload(nb, scratch, MEDIUM);
    const before = snapshot(first);
    // AO and smooth light off change the data words and the merge, so the second call writes other bytes.
    const second = meshColumnPayload(nb, scratch, { ao: false, smoothLight: false });
    expect(payloadProblem(second)).toBeNull();
    expect([...second.data]).not.toEqual([...first.data]);
    expect(snapshot(first)).toEqual(before);
  });
});

describe('meshColumnPayload on an all-trivial column', () => {
  test('an all-air world: every section trivial air, zero-length arrays, connectivity 0x7FFF', () => {
    const s = createStore({ shared: false, maxBlockBytes: 4 * MiB, maxByteBytes: 4 * MiB });
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const w = s.claimColumn(dx, dz, 0);
        const blocks = new Uint16Array(4096).fill(AIR);
        const bytes = new Uint8Array(4096);
        for (let sy = 0; sy < SECTIONS; sy++) w.setFinal(sy, blocks, bytes, bytes);
        w.commit(3);
      }
    }
    const nb = s.neighborhood(0, 0);
    const p = meshColumnPayload(nb, createMeshScratch(), MEDIUM);
    expect(payloadProblem(p)).toBeNull();
    // sy 0's lower neighbour is the bedrock below the world, so it is not trivial; it meshes nothing either.
    expect(isTrivial(nb, 0)).toBe(0);
    for (let sy = 1; sy < SECTIONS; sy++) expect(isTrivial(nb, sy), `sy ${sy}`).toBe(1);
    expect([...p.connectivity]).toEqual(new Array(SECTIONS).fill(ALL_PAIRS));
    for (const a of [p.position, p.data, p.index, p.rows, p.spheres]) expect(a.length).toBe(0);
    const buffers = Object.values(arraysOf(p)).map((a) => a.buffer);
    expect(new Set(buffers).size).toBe(7);
  });
});

describe('meshColumnJob (SP4a spec §2.3)', () => {
  let store: VoxelStore;
  beforeAll(() => {
    store = filledL();
  });

  test('on a Published 3 × 3 it returns the payload of meshColumnPayload', () => {
    const p = meshColumnJob(store, CX, CZ, createMeshScratch(), MEDIUM);
    const q = meshColumnPayload(store.neighborhood(CX, CZ), createMeshScratch(), MEDIUM);
    expect(snapshot(p)).toEqual(snapshot(q));
  });

  test('throws on a neighbour below Published', () => {
    // (CX + 2, CZ) is Decorated, so the 3 × 3 of (CX + 1, CZ) is not all Published.
    expect(store.table.status(store.table.find(CX + 2, CZ))).toBe(STATUS_DECORATED);
    expect(() => meshColumnJob(store, CX + 1, CZ, createMeshScratch(), MEDIUM)).toThrow(/Published/);
    // A missing column (outside the filled 7 × 7) likewise.
    expect(() => meshColumnJob(store, CX + 4, CZ, createMeshScratch(), MEDIUM)).toThrow(/Published/);
  });
});
