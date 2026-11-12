/**
 * A world saved before SP6a, opened with edits in what are now caves (the SP6a plan's Review Focus 2; spec §3.3,
 * §12.4, D20, D36): a GV5 record (schema 2, `params.density.defs` the SP5c default tree of
 * `test/fixtures/sp5c-density-trees.json`) whose `ColumnDiffV1` places stone at a voxel the T stage now tags cheese and
 * digs a voxel T leaves solid, opened through `openPersistWorld` (the page's open on the real stack). The world opens
 * with today's tree and the older-generator flag; the edits read back; the placed stone keeps the T stage's tag in the
 * final set (`replaceBlocks` keeps the section's cave entry) and the dug voxel's tag is 0 (it was rock: not cave).
 * The X-ray's half (Task 17, SP6a spec §5.1): `meshXray` over the final sets' padded sections shows a wall toward the
 * placed stone from each hollow neighbour, kind its tag, and no face owned by the dug voxel (air, tag 0: not hollow).
 */
import { expect, test } from 'vitest';
import { CAVE_KIND, caveKindOf } from '../../src/core/constants';
import { colKey } from '../../src/core/coords';
import { parseHex64 } from '../../src/core/hash';
import { canonicalJSON } from '../../src/core/params/canonical';
import { DEFAULT_DENSITY_TREE } from '../../src/core/params/defaultTrees';
import type { JsonObject } from '../../src/core/params/migrate';
import { terrainStage } from '../../src/gen/pipeline/terrainStage';
import { createMeshBuilder } from '../../src/mesh/builder';
import { unpackXray } from '../../src/mesh/packing';
import { meshXray } from '../../src/mesh/xray';
import { encodeColumnDiff } from '../../src/persist/diffCodec';
import { createMemoryKV } from '../../src/persist/memory';
import { createSaves, loadParams, newState } from '../../src/persist/saves';
import { DEFAULT_MAP_STATE, openMapSession } from '../../src/ui/map/mapState';
import { STATE_BOUNDS } from '../../src/ui/world/stateBounds';
import { newWorldRecord, OLDER_GENERATOR_NOTICE } from '../../src/ui/world/worldPage';
import { AIR, FULL_FACES, PASS, STONE } from '../../src/world/blocks/index';
import { ALL_FACES, PASS_OPAQUE } from '../../src/world/blocks/kinds';
import type { NeighborhoodReader } from '../../src/world/store/api';
import { copyPaddedSection, createPaddedSection, padIndex } from '../../src/world/store/padded';
import { createStore } from '../../src/world/store/store';
import { ctxFor } from '../harness/gen';
import { openPersistWorld } from '../harness/persistWorld';
import { sp5cTrees } from '../harness/sp5cTrees';

const MiB = 1 << 20;
/** A generator key no world of today's generator has (the record's, from SP5c). */
const OLD = 'f00df00df00df00d';

interface Voxel { readonly x: number; readonly y: number; readonly z: number }

/** Per face (north, east, south, west, up, down): the normal axis, its sign and the unit normal (master face order). */
const AXIS = [2, 0, 2, 0, 1, 1] as const;
const SIGN = [-1, 1, 1, -1, 1, -1] as const;
const NORMAL: ReadonlyArray<readonly [number, number, number]> = [[0, 0, -1], [1, 0, 0], [0, 0, 1], [-1, 0, 0], [0, 1, 0], [0, -1, 0]];
const OPPOSITE = [2, 3, 0, 1, 5, 4] as const;

/**
 * The X-ray faces of section `sy` of column (cx, cz), each unit face keyed `x,y,z,face,kind` by the world voxel that
 * owns it, and the section's padded copy (`meshXray` over `copyPaddedSection`, as the mesh job runs it).
 */
function xrayFaces(nb: NeighborhoodReader, cx: number, cz: number, sy: number): { faces: Set<string>; tagAt: (v: Voxel) => number; blockAt: (v: Voxel) => number } {
  const padded = createPaddedSection();
  copyPaddedSection(nb, sy, padded);
  const b = createMeshBuilder();
  meshXray(padded, b);
  const view = b.view(3);
  const faces = new Set<string>();
  for (let q = 0; q < view.vertices / 4; q++) {
    const { face: f, kind } = unpackXray(view.data[4 * q]!);
    const corners = [0, 1, 2, 3].map((k) => [0, 1, 2].map((a) => view.position[4 * (4 * q + k) + a]! / 8));
    const lo = [0, 1, 2].map((a) => Math.min(...corners.map((c) => c[a]!)));
    const hi = [0, 1, 2].map((a) => Math.max(...corners.map((c) => c[a]!)));
    const a = AXIS[f]!;
    lo[a] = SIGN[f]! > 0 ? corners[0]![a]! - 1 : corners[0]![a]!;
    hi[a] = lo[a]! + 1;
    for (let y = lo[1]!; y < hi[1]!; y++) {
      for (let z = lo[2]!; z < hi[2]!; z++) {
        for (let x = lo[0]!; x < hi[0]!; x++) faces.add(`${16 * cx + x},${16 * sy - 64 + y},${16 * cz + z},${f},${kind}`);
      }
    }
  }
  const local = (v: Voxel): number => padIndex(v.x - 16 * cx, v.y + 64 - 16 * sy, v.z - 16 * cz);
  return { faces, tagAt: (v) => padded.cave[local(v)]! & 15, blockAt: (v) => padded.blocks[local(v)]! };
}

/**
 * The first column of seed 42 (default) from (0, 0) outward whose T output holds a cheese-tagged voxel: that voxel and
 * a voxel T leaves solid (stone, tag 0) in the same column.
 */
function findVoxels(): { cx: number; cz: number; cheese: Voxel; rock: Voxel } {
  const ctx = ctxFor('42');
  for (let r = 0; r < 6; r++) {
    for (let dz = (-r) | 0; dz <= r; dz++) {
      for (let dx = (-r) | 0; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const store = createStore({ shared: false, maxBlockBytes: 8 * MiB, maxByteBytes: 8 * MiB });
        const w = store.claimColumn(dx, dz, 0);
        expect(terrainStage(ctx, dx, dz, w, () => false)).toBe(true);
        w.commit(1);
        const v = store.proto(dx, dz)!;
        let cheese: Voxel | null = null, rock: Voxel | null = null;
        for (let y = -63; y < 320 && (cheese === null || rock === null); y++) {
          for (let lz = 0; lz < 16; lz++) {
            for (let lx = 0; lx < 16; lx++) {
              const at = { x: 16 * dx + lx, y, z: 16 * dz + lz };
              if (cheese === null && caveKindOf(v.cave(lx, y, lz)) === CAVE_KIND.cheese && v.block(lx, y, lz) === AIR) cheese = at;
              if (rock === null && y > 0 && v.block(lx, y, lz) === STONE && v.cave(lx, y, lz) === 0) rock = at;
            }
          }
        }
        if (cheese !== null && rock !== null) return { cx: dx, cz: dz, cheese, rock };
      }
    }
  }
  throw new Error('no cheese voxel within 5 columns of (0, 0)');
}

test('a GV5 world with edits in what are now caves opens with the caves: today\'s tree, the older-generator flag, the edits read back, the stone keeps its cheese tag and the dug voxel has none; the X-ray walls the stone and not the dug voxel (Review Focus 2)', async () => {
  const { cx, cz, cheese, rock } = findVoxels();
  const kv = createMemoryKV();
  const id = 'gv5';
  const session = openMapSession({ ...DEFAULT_MAP_STATE, seed: '42', profile: 'default' }, () => [1, 2]);
  const world = newWorldRecord(id, 'A GV5 world', session.state, 1_700_000_000_000);
  const state = { ...newState(id, STATE_BOUNDS), player: { x: 16 * cx + 8.5, y: 140.25, z: 16 * cz + 7.5, yaw: 0, pitch: -10, mode: 'fly' as const, speed: 12 } };
  expect((await createSaves(kv).create(world, state)).status).toBe('complete');
  // The SP5c record: schema 2, the SP5c default tree, generator version 5 and its genKey; one column of edits.
  const sp5c = { density: { defs: sp5cTrees().default } } as unknown as JsonObject;
  const entry = (v: Voxel, value: number) => ({ sy: (v.y + 64) >> 4, idx: (((v.y + 64) & 15) << 8) | ((v.z & 15) << 4) | (v.x & 15), value });
  const entries = [entry(cheese, STONE << 8), entry(rock, AIR << 8)];
  expect((await kv.write([
    { op: 'put', store: 'worlds', key: id, value: { ...world, params: sp5c, schemaVersion: 2, generatorVersion: 5, genKey: OLD } },
    { op: 'put', store: 'diffs', key: [id, colKey(cx, cz)], value: encodeColumnDiff({
      sy: Uint8Array.from(entries, (e) => e.sy), idx: Uint16Array.from(entries, (e) => e.idx), value: Uint32Array.from(entries, (e) => e.value),
    }, parseHex64(OLD)) },
  ])).status).toBe('complete');

  const p = await openPersistWorld({ kv, worldId: id, rd: 4 });
  try {
    expect([p.centre.cx, p.centre.cz]).toEqual([cx, cz]);
    // Opened with today's tree (D36's migration) and flagged older (D8), its notice shown once.
    const params = loadParams(p.kept());
    expect(params.ok).toBe(true);
    if (!params.ok) return;
    expect(canonicalJSON(params.value.density.defs)).toBe(canonicalJSON(DEFAULT_DENSITY_TREE));
    expect(p.opened.older).toBe(true);
    expect(p.notices.filter((t) => t === OLDER_GENERATOR_NOTICE).length).toBe(1);
    p.store.enterRead();
    try {
      // The edits read back: the stone floats where it was placed, the dug voxel is air.
      expect(p.store.blockAt(cheese.x, cheese.y, cheese.z)).toBe(STONE);
      expect(p.store.blockAt(rock.x, rock.y, rock.z)).toBe(AIR);
      // The final set keeps T's tag under the edit (`replaceBlocks` kept the section's cave entry); the dug voxel: 0.
      const fin = p.store.final(cx, cz)!;
      expect(caveKindOf(fin.cave(cheese.x & 15, cheese.y, cheese.z & 15))).toBe(CAVE_KIND.cheese);
      expect(fin.cave(rock.x & 15, rock.y, rock.z & 15)).toBe(0);
      expect(fin.block(cheese.x & 15, cheese.y, cheese.z & 15)).toBe(STONE);

      // The X-ray (spec §5.1): each hollow neighbour of the placed stone shows a wall toward it, kind its tag; the stone
      // is an opaque full cube, so it is not hollow and owns no face.
      const opaqueFull = (s: number): boolean => PASS[s] === PASS_OPAQUE && FULL_FACES[s] === ALL_FACES;
      const sectionOf = (v: Voxel): number => (v.y + 64) >> 4;
      const nb = p.store.neighborhood(cx, cz);
      let walls = 0;
      for (let f = 0; f < 6; f++) {
        const [dx, dy, dz] = NORMAL[f]!;
        const n = { x: cheese.x + dx, y: cheese.y + dy, z: cheese.z + dz };
        const ncx = n.x >> 4;
        const ncz = n.z >> 4;
        const x = xrayFaces(ncx === cx && ncz === cz ? nb : p.store.neighborhood(ncx, ncz), ncx, ncz, sectionOf(n));
        const tag = x.tagAt(n);
        if (tag === 0 || opaqueFull(x.blockAt(n))) continue;
        expect(x.faces, `the hollow neighbour ${n.x},${n.y},${n.z} (kind ${tag}) shows no wall toward the placed stone`).toContain(`${n.x},${n.y},${n.z},${OPPOSITE[f]},${tag}`);
        walls++;
      }
      expect(walls, 'the placed stone has no hollow neighbour (the case is vacuous)').toBeGreaterThan(0);
      const own = xrayFaces(nb, cx, cz, sectionOf(cheese));
      expect([...own.faces].filter((k) => k.startsWith(`${cheese.x},${cheese.y},${cheese.z},`))).toEqual([]);
      // The dug voxel: air with tag 0 (it was rock), so not hollow: it owns no X-ray face.
      const dug = xrayFaces(nb, cx, cz, sectionOf(rock));
      expect(dug.tagAt(rock)).toBe(0);
      expect(dug.blockAt(rock)).toBe(AIR);
      expect([...dug.faces].filter((k) => k.startsWith(`${rock.x},${rock.y},${rock.z},`))).toEqual([]);
    } finally {
      p.store.exitRead();
    }
  } finally {
    p.dispose();
  }
});
