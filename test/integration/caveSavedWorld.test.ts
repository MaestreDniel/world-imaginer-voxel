/**
 * A world saved before SP6a, opened with edits in what are now caves (the SP6a plan's Review Focus 2; spec §3.3,
 * §12.4, D20, D36): a GV5 record (schema 2, `params.density.defs` the SP5c default tree of
 * `test/fixtures/sp5c-density-trees.json`) whose `ColumnDiffV1` places stone at a voxel the T stage now tags cheese and
 * digs a voxel T leaves solid, opened through `openPersistWorld` (the page's open on the real stack). The world opens
 * with today's tree and the older-generator flag; the edits read back; the placed stone keeps the T stage's tag in the
 * final set (`replaceBlocks` keeps the section's cave entry) and the dug voxel's tag is 0 (it was rock: not cave).
 * The X-ray's half (Task 17, SP6a spec §5.1): `meshXray` over the final sets' padded sections shows a wall toward the
 * placed stone from each hollow neighbour, kind its tag, and no face owned by the dug voxel (air, tag 0: not hollow).
 *
 * SP6b's Review Focus 2 (Task 20; spec §5.2, §14.4, D29): a GV8 world (schema 4, both built-in trees as GV8 stored them,
 * `test/fixtures/gv8-*-trees.json`) whose diff digs (x, −60, z), which today's T leaves rock under the rock floor, and
 * places stone at a cave voxel above it, opens with today's trees (the migration) and the older-generator flag; the dug
 * voxel reads air with cave byte 0, the placed stone keeps its column's whole cave byte (kind and cave biome), and the
 * X-ray shows no wall toward the dug voxel and none owned by it. Task 22 extends it: the stone is placed where SP6b's
 * rule 4 would put a cave block (moss, clay, dripstone, ash or the abyss's strata) were the voxel generated solid, and it
 * keeps its state: rule 4 never runs on a published edit.
 *
 * SP7a's Review Focus 1 (Task 18; spec §9.3, §15.4, D23, D34): a GV9 world (schema 5, the GV9 default surface tree of
 * `test/fixtures/gv9-surface-trees.json`) whose diff digs three voxels of a cave that today's aquifer floods (air with
 * fluid 0 at three tagged voxels stacked on the cave's floor voxel, each where today's `fluidAt` is water) and places
 * stone at that floor voxel, opens with today's surface tree and the older-generator flag; the dug voxels stay a dry
 * pocket (no sim until SP7b) with the water around them as D generated it (`WATER_SOURCE`, or the settled byte where
 * the generated-fluid layer holds the section); the stone keeps its state and its column's cave byte; a `revert` of a
 * dug voxel writes the generated value (`store.generated`), removes its entry, and reads the same after a reload; and
 * `meshFluid` draws the water's faces toward the pocket.
 */
import { expect, test } from 'vitest';
import { CAVE_KIND, caveKindOf } from '../../src/core/constants';
import { colKey } from '../../src/core/coords';
import { parseHex64 } from '../../src/core/hash';
import { canonicalJSON } from '../../src/core/params/canonical';
import { DEFAULT_DENSITY_TREE, DEFAULT_SURFACE_RULES } from '../../src/core/params/defaultTrees';
import { resolveProfile } from '../../src/core/params/profiles';
import type { JsonObject } from '../../src/core/params/migrate';
import { cavePickerOf } from '../../src/gen/biomes/cavePicker';
import { terrainStage } from '../../src/gen/pipeline/terrainStage';
import { createDensityContext } from '../../src/gen/density/context';
import { aquiferOf, fluidAt } from '../../src/gen/fluids/aquifer';
import { surfaceContextOf } from '../../src/gen/surface/context';
import { surfaceProbeColumn } from '../../src/gen/surface/probe';
import { newSurfaceScan, scanColumn } from '../../src/gen/surface/scan';
import { createMeshBuilder } from '../../src/mesh/builder';
import { fluidDepths, meshFluid } from '../../src/mesh/fluid';
import { unpackFluid } from '../../src/mesh/packing';
import { unpackXray } from '../../src/mesh/packing';
import { meshXray } from '../../src/mesh/xray';
import { encodeColumnDiff } from '../../src/persist/diffCodec';
import { createMemoryKV } from '../../src/persist/memory';
import { createSaves, loadParams, newState } from '../../src/persist/saves';
import { DEFAULT_MAP_STATE, openMapSession } from '../../src/ui/map/mapState';
import { STATE_BOUNDS } from '../../src/ui/world/stateBounds';
import { newWorldRecord, OLDER_GENERATOR_NOTICE } from '../../src/ui/world/worldPage';
import { FLUID_WATER, fluidType, NO_FLUID, WATER_SOURCE } from '../../src/world/blocks/fluid';
import { AIR, FULL_FACES, PASS, REGISTRY, STONE } from '../../src/world/blocks/index';
import { ALL_FACES, PASS_OPAQUE } from '../../src/world/blocks/kinds';
import type { NeighborhoodReader } from '../../src/world/store/api';
import { REC_GEN_FLUID_MASK } from '../../src/world/store/columnTable';
import { copyPaddedSection, createPaddedSection, padIndex } from '../../src/world/store/padded';
import { createStore, type VoxelStore } from '../../src/world/store/store';
import { ctxFor } from '../harness/gen';
import { gv8DensityTrees, gv8SurfaceTrees } from '../harness/gv8Trees';
import { gv9SurfaceTrees } from '../harness/gv9Trees';
import { openPersistWorld } from '../harness/persistWorld';
import { genRegion } from '../harness/region';
import { sp5cTrees } from '../harness/sp5cTrees';
import { quadsOf } from '../unit/fixtures/padded';

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

/** Rule 4's states (SP6b spec §3.4). */
const RULE4_STATES: ReadonlySet<number> = new Set(['moss_block', 'clay', 'dripstone_block', 'abyss_ash', 'abyss_stone', 'abyss_shale', 'cracked_abyss_stone', 'abyss_stone_veined'].map((k) => REGISTRY.parseStateKey(k)));

/**
 * The first column of seed 42 (default, today's T) from (0, 0) outward holding a tagged air voxel at y > −60 whose cave
 * byte carries a cave biome (high nibble ≠ 0) and that rule 4 would give one of its states were it solid (the default
 * rules over the probe's rebuild of the column with that voxel made solid; the first column with any tagged air voxel
 * when none within 5 does), and a position whose voxel at y −60 T leaves solid with cave byte 0 (rock under the rock
 * floor): that voxel at −60, the cave voxel with its whole cave byte, and the state rule 4 would give it (or −1).
 */
function findFloorVoxels(): { cx: number; cz: number; dug: Voxel; cave: Voxel; caveByte: number; ruled: number } {
  const ctx = ctxFor('42');
  const sc = surfaceContextOf(ctx);
  /** The default rules' state at voxel (lx, y, lz) of column (cx, cz) made solid, on the probe's rebuild of the column. */
  const solidState = (cx: number, cz: number, lx: number, y: number, lz: number): number => {
    const c = surfaceProbeColumn(sc, cx, cz);
    const p = (lz << 4) | lx;
    const solid = c.solid.slice();
    solid[256 * (y + 64) + p] = 1;
    const scan = scanColumn(newSurfaceScan(), sc.settings, sc.density.columns.get(cx, cz), solid, c.water, c.biomes, c.tags, { inputs: cavePickerOf(ctx), pass: c.pass });
    return sc.reference.state(scan, sc.settings, p, y);
  };
  let fallback: { cx: number; cz: number; dug: Voxel; cave: Voxel; caveByte: number; ruled: number } | null = null;
  for (let r = 0; r < 6; r++) {
    for (let dz = (-r) | 0; dz <= r; dz++) {
      for (let dx = (-r) | 0; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const store = createStore({ shared: false, maxBlockBytes: 8 * MiB, maxByteBytes: 8 * MiB });
        const w = store.claimColumn(dx, dz, 0);
        expect(terrainStage(ctx, dx, dz, w, () => false)).toBe(true);
        w.commit(1);
        const v = store.proto(dx, dz)!;
        let dug: Voxel | null = null;
        for (let q = 0; q < 256 && dug === null; q++) {
          if (v.block(q & 15, -60, q >> 4) !== AIR && v.cave(q & 15, -60, q >> 4) === 0) dug = { x: 16 * dx + (q & 15), y: -60, z: 16 * dz + (q >> 4) };
        }
        if (dug === null) continue;
        for (let y = -59; y < 320; y++) {
          for (let lz = 0; lz < 16; lz++) {
            for (let lx = 0; lx < 16; lx++) {
              const b = v.cave(lx, y, lz);
              if (caveKindOf(b) === 0 || v.block(lx, y, lz) !== AIR) continue;
              const found = { cx: dx, cz: dz, dug, cave: { x: 16 * dx + lx, y, z: 16 * dz + lz }, caveByte: b, ruled: -1 };
              fallback ??= found;
              if (b >> 4 === 0) continue;
              const ruled = solidState(dx, dz, lx, y, lz);
              if (RULE4_STATES.has(ruled)) return { ...found, ruled };
            }
          }
        }
      }
    }
  }
  if (fallback === null) throw new Error('no cave voxel above the rock floor within 5 columns of (0, 0)');
  return fallback;
}

test('a GV8 world with edits where the rock floor closes opens with the floor and the cave biomes: today\'s trees, the older-generator flag, the dug voxel air with cave byte 0, the placed stone keeps its column\'s byte and its state (rule 4 never runs on a published edit); the X-ray walls nothing toward the dug voxel (SP6b Review Focus 2)', async () => {
  const { cx, cz, dug, cave, caveByte, ruled } = findFloorVoxels();
  // Rule 4 would give the placed voxel one of its cave states were T to generate it solid (Task 22: not vacuous).
  expect(RULE4_STATES.has(ruled), `rule 4 gives ${ruled} at the placed voxel`).toBe(true);
  const kv = createMemoryKV();
  const id = 'gv8';
  const session = openMapSession({ ...DEFAULT_MAP_STATE, seed: '42', profile: 'default' }, () => [1, 2]);
  const world = newWorldRecord(id, 'A GV8 world', session.state, 1_700_000_000_000);
  const state = { ...newState(id, STATE_BOUNDS), player: { x: 16 * cx + 8.5, y: 140.25, z: 16 * cz + 7.5, yaw: 0, pitch: -10, mode: 'fly' as const, speed: 12 } };
  expect((await createSaves(kv).create(world, state)).status).toBe('complete');
  // The GV8 record: schema 4, the default profile's params with both built-in trees as GV8 stored them, generator
  // version 8 and a genKey no world of today's generator has; one column of edits.
  const params = JSON.parse(canonicalJSON(resolveProfile('default'))) as Record<string, Record<string, unknown>>;
  params['density']!['defs'] = gv8DensityTrees().default;
  params['surface']!['rules'] = gv8SurfaceTrees().default;
  expect(canonicalJSON(params['density']!['defs'])).not.toBe(canonicalJSON(DEFAULT_DENSITY_TREE));
  expect(canonicalJSON(params['surface']!['rules'])).not.toBe(canonicalJSON(DEFAULT_SURFACE_RULES));
  const entry = (v: Voxel, value: number) => ({ sy: (v.y + 64) >> 4, idx: (((v.y + 64) & 15) << 8) | ((v.z & 15) << 4) | (v.x & 15), value });
  const entries = [entry(dug, AIR << 8), entry(cave, STONE << 8)];
  expect((await kv.write([
    { op: 'put', store: 'worlds', key: id, value: { ...world, params: params as unknown as JsonObject, schemaVersion: 4, generatorVersion: 8, genKey: OLD } },
    { op: 'put', store: 'diffs', key: [id, colKey(cx, cz)], value: encodeColumnDiff({
      sy: Uint8Array.from(entries, (e) => e.sy), idx: Uint16Array.from(entries, (e) => e.idx), value: Uint32Array.from(entries, (e) => e.value),
    }, parseHex64(OLD)) },
  ])).status).toBe('complete');

  const p = await openPersistWorld({ kv, worldId: id, rd: 4 });
  try {
    expect([p.centre.cx, p.centre.cz]).toEqual([cx, cz]);
    // Both trees are today's (MIGRATIONS[3] maps each GV8 tree to the live built-in one, D29); flagged older.
    const loaded = loadParams(p.kept());
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    // Identity (ruling P14); since SP6b's rule 4 (Task 22) the GV8 surface tree differs from today's canonically too.
    expect(loaded.value.density.defs).toBe(resolveProfile('default').density.defs);
    expect(loaded.value.surface.rules).toBe(resolveProfile('default').surface.rules);
    expect(canonicalJSON(loaded.value.density.defs)).toBe(canonicalJSON(DEFAULT_DENSITY_TREE));
    expect(canonicalJSON(loaded.value.surface.rules)).toBe(canonicalJSON(DEFAULT_SURFACE_RULES));
    expect(p.opened.older).toBe(true);
    expect(p.notices.filter((t) => t === OLDER_GENERATOR_NOTICE).length).toBe(1);
    p.store.enterRead();
    try {
      const fin = p.store.final(cx, cz)!;
      // The dug voxel under the floor: air, cave byte 0 (it was rock, not cave).
      expect(p.store.blockAt(dug.x, dug.y, dug.z)).toBe(AIR);
      expect(fin.cave(dug.x & 15, dug.y, dug.z & 15)).toBe(0);
      // The placed stone keeps its column's whole cave byte (kind and cave biome; `replaceBlocks` keeps the cave entry)
      // and its state (Task 22): the published edit is never re-ruled, so no moss, dripstone, ash or strata replaces it.
      expect(p.store.blockAt(cave.x, cave.y, cave.z)).toBe(STONE);
      expect(fin.block(cave.x & 15, cave.y, cave.z & 15)).toBe(STONE);
      expect(fin.cave(cave.x & 15, cave.y, cave.z & 15)).toBe(caveByte);

      // The X-ray: the dug voxel is not hollow (air, tag 0), so it owns no face, and no neighbour shows a wall toward it.
      const sectionOf = (v: Voxel): number => (v.y + 64) >> 4;
      const nb = p.store.neighborhood(cx, cz);
      const own = xrayFaces(nb, cx, cz, sectionOf(dug));
      expect(own.tagAt(dug)).toBe(0);
      expect(own.blockAt(dug)).toBe(AIR);
      expect([...own.faces].filter((k) => k.startsWith(`${dug.x},${dug.y},${dug.z},`))).toEqual([]);
      for (let f = 0; f < 6; f++) {
        const [dx, dy, dz] = NORMAL[f]!;
        const n = { x: dug.x + dx, y: dug.y + dy, z: dug.z + dz };
        const ncx = n.x >> 4;
        const ncz = n.z >> 4;
        const x = xrayFaces(ncx === cx && ncz === cz ? nb : p.store.neighborhood(ncx, ncz), ncx, ncz, sectionOf(n));
        expect([...x.faces].filter((k) => k.startsWith(`${n.x},${n.y},${n.z},${OPPOSITE[f]},`)), `a wall from ${n.x},${n.y},${n.z} toward the dug voxel`).toEqual([]);
      }
    } finally {
      p.store.exitRead();
    }
  } finally {
    p.dispose();
  }
});

/**
 * A cave floor under water in seed 42 (default, today's generator), found by a scan of the 7 × 7 columns around (0, 0)
 * generated up to 'D' (`genRegion`), each at local x and z 1 … 14 and y upward: a tagged air voxel holding water on a
 * solid voxel (the floor voxel, `stone`) with three more tagged water voxels stacked on it (`dug`, bottom first), each
 * with water beside it in the column, every one of the four where today's `fluidAt` is water. The first such floor
 * (columns row-major) whose dug voxels lie in sections the column's generated-fluid layer holds (the settle changed
 * them), else the first one.
 */
async function findFloodedFloor(): Promise<{ cx: number; cz: number; stone: Voxel; dug: Voxel[]; settled: boolean }> {
  const ctx = ctxFor('42');
  const inp = aquiferOf(ctx);
  const dc = createDensityContext(ctx);
  const store = (await genRegion({ seed: '42', params: resolveProfile('default'), cx0: -3, cz0: -3, w: 7, h: 7, upTo: 'D', order: 'spiral', threads: 1 })).view.store;
  let first: { cx: number; cz: number; stone: Voxel; dug: Voxel[]; settled: boolean } | null = null;
  for (let cz = -3; cz <= 3; cz++) {
    for (let cx = -3; cx <= 3; cx++) {
      const v = store.proto(cx, cz)!;
      const mask = store.table.ints[store.table.find(cx, cz) + REC_GEN_FLUID_MASK]!;
      const wet = (lx: number, y: number, lz: number): boolean =>
        v.block(lx, y, lz) === AIR && caveKindOf(v.cave(lx, y, lz)) !== 0 && fluidType(v.fluid(lx, y, lz)) === FLUID_WATER;
      const waterBeside = (lx: number, y: number, lz: number): boolean =>
        [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([ox, oz]) => fluidType(v.fluid(lx + ox!, y, lz + oz!)) === FLUID_WATER);
      for (let lz = 1; lz < 15; lz++) {
        for (let lx = 1; lx < 15; lx++) {
          for (let y = -62; y < 316; y++) {
            if (v.block(lx, y - 1, lz) === AIR || v.fluid(lx, y - 1, lz) !== NO_FLUID) continue;
            if (![0, 1, 2, 3].every((k) => wet(lx, y + k, lz)) || ![1, 2, 3].every((k) => waterBeside(lx, y + k, lz))) continue;
            const four = [0, 1, 2, 3].map((k): Voxel => ({ x: 16 * cx + lx, y: y + k, z: 16 * cz + lz }));
            // Today's point function agrees with T at each (DT2's `aquiferProbe`): water.
            for (const q of four) expect(fluidAt(inp, dc, q.x, q.y, q.z), `fluidAt (${q.x}, ${q.y}, ${q.z})`).toBe(v.fluid(lx, q.y, lz));
            const settled = [1, 2, 3].every((k) => ((mask >>> ((y + k + 64) >> 4)) & 1) !== 0);
            const found = { cx, cz, stone: four[0]!, dug: four.slice(1), settled };
            if (settled) return found;
            first ??= found;
          }
        }
      }
    }
  }
  if (first === null) throw new Error('no flooded cave floor within 3 columns of (0, 0)');
  return first;
}

/**
 * The unit faces of section `sy` of column (cx, cz) that `meshFluid` emits in the translucent pass, keyed
 * `x,y,z,face` by the world voxel that owns each (as the mesh job runs it: `copyPaddedSection`, `fluidDepths`).
 */
function waterFaces(nb: NeighborhoodReader, cx: number, cz: number, sy: number): Set<string> {
  const padded = createPaddedSection();
  copyPaddedSection(nb, sy, padded);
  const depth = new Uint8Array(4096);
  fluidDepths(nb, sy, depth);
  const b = createMeshBuilder();
  meshFluid(padded, depth, b);
  const faces = new Set<string>();
  for (const q of quadsOf(b.view(2))) {
    const f = unpackFluid(q.words[0]!).face;
    const a = AXIS[f]!;
    const plane = q.corners[0]![a]! / 8;
    const lo = [0, 1, 2].map((ax) => Math.min(...q.corners.map((c) => c[ax]!)) / 8);
    const hi = [0, 1, 2].map((ax) => Math.max(...q.corners.map((c) => c[ax]!)) / 8);
    lo[a] = SIGN[f]! > 0 ? plane - 1 : plane;
    hi[a] = lo[a]! + 1;
    // A side strip (all four positions at one y) covers the voxels whose top that y is.
    if (a !== 1 && lo[1] === hi[1]) lo[1] = hi[1]! - 1;
    for (let y = Math.floor(lo[1]!); y < hi[1]!; y++) {
      for (let z = lo[2]!; z < hi[2]!; z++) {
        for (let x = lo[0]!; x < hi[0]!; x++) faces.add(`${16 * cx + x},${16 * sy - 64 + y},${16 * cz + z},${f}`);
      }
    }
  }
  return faces;
}

test('a GV9 world with edits in a cave that now floods opens with the water: today\'s surface tree, the older-generator flag, the dug voxels a dry pocket in the generated water, the stone keeps its state and cave byte; a revert writes the generated value, removes its entry and survives a reload; meshFluid draws the water toward the pocket (SP7a Review Focus 1)', async () => {
  const { cx, cz, stone, dug, settled } = await findFloodedFloor();
  const kv = createMemoryKV();
  const id = 'gv9';
  const session = openMapSession({ ...DEFAULT_MAP_STATE, seed: '42', profile: 'default' }, () => [1, 2]);
  const world = newWorldRecord(id, 'A GV9 world', session.state, 1_700_000_000_000);
  const state = { ...newState(id, STATE_BOUNDS), player: { x: 16 * cx + 8.5, y: 140.25, z: 16 * cz + 7.5, yaw: 0, pitch: -10, mode: 'fly' as const, speed: 12 } };
  expect((await createSaves(kv).create(world, state)).status).toBe('complete');
  // The GV9 record: schema 5, the default profile's params with the GV9 default surface tree, generator version 9 and
  // a genKey no world of today's generator has; one column of edits: the three dug voxels and the stone on the floor.
  const params = JSON.parse(canonicalJSON(resolveProfile('default'))) as Record<string, Record<string, unknown>>;
  // (Canonically equal to today's tree until rule 4's under-water branches, SP7a Task 29; the migration maps it by its
  // hash to the live built-in tree either way.)
  params['surface']!['rules'] = gv9SurfaceTrees().default;
  const sectionOf = (v: Voxel): number => (v.y + 64) >> 4;
  const indexOf = (v: Voxel): number => (((v.y + 64) & 15) << 8) | ((v.z & 15) << 4) | (v.x & 15);
  const entry = (v: Voxel, value: number) => ({ sy: sectionOf(v), idx: indexOf(v), value });
  const entries = [...dug.map((v) => entry(v, (AIR << 8) | NO_FLUID)), entry(stone, STONE << 8)];
  expect((await kv.write([
    { op: 'put', store: 'worlds', key: id, value: { ...world, params: params as unknown as JsonObject, schemaVersion: 5, generatorVersion: 9, genKey: OLD } },
    { op: 'put', store: 'diffs', key: [id, colKey(cx, cz)], value: encodeColumnDiff({
      sy: Uint8Array.from(entries, (e) => e.sy), idx: Uint16Array.from(entries, (e) => e.idx), value: Uint32Array.from(entries, (e) => e.value),
    }, parseHex64(OLD)) },
  ])).status).toBe('complete');

  const key = (v: Voxel): string => `${v.x},${v.y},${v.z}`;
  const edited = new Set([...dug, stone].map(key));
  const valueAt = (s: VoxelStore, v: Voxel): number => ((s.blockAt(v.x, v.y, v.z) << 8) | s.fluidAt(v.x, v.y, v.z)) >>> 0;
  const reverted = dug[1]!;
  let generatedValue = -1;
  const p = await openPersistWorld({ kv, worldId: id, rd: 4 });
  try {
    expect([p.centre.cx, p.centre.cz]).toEqual([cx, cz]);
    // Today's surface tree (MIGRATIONS[4] maps the GV9 tree to the live built-in one, D34); flagged older.
    const loaded = loadParams(p.kept());
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.surface.rules).toBe(resolveProfile('default').surface.rules);
    expect(p.opened.older).toBe(true);
    expect(p.notices.filter((t) => t === OLDER_GENERATOR_NOTICE).length).toBe(1);
    p.store.enterRead();
    try {
      const fin = p.store.final(cx, cz)!;
      const gen = p.store.generated(cx, cz)!;
      const proto = p.store.proto(cx, cz)!;
      const mask = p.store.table.ints[p.store.table.find(cx, cz) + REC_GEN_FLUID_MASK]!;
      // The open's D settles as the scan's did: the layer holds the dug voxels' sections exactly when the scan found so.
      expect(dug.every((v) => ((mask >>> sectionOf(v)) & 1) !== 0)).toBe(settled);
      // The dug voxels: air with fluid 0, a dry pocket (saved diffs are absolute; no sim until SP7b).
      for (const v of dug) expect([key(v), valueAt(p.store, v)]).toEqual([key(v), (AIR << 8) | NO_FLUID]);
      // Their unedited neighbours: the water D generated, a proto source or, where the layer holds the section, the
      // settled byte.
      let water = 0;
      for (const v of dug) {
        for (const [ox, oy, oz] of NORMAL) {
          const n = { x: v.x + ox, y: v.y + oy, z: v.z + oz };
          if (edited.has(key(n))) continue;
          const f = p.store.fluidAt(n.x, n.y, n.z);
          const g = gen.fluid(n.x & 15, n.y, n.z & 15);
          expect([key(n), f]).toEqual([key(n), g]);
          if (((mask >>> sectionOf(n)) & 1) === 0 && fluidType(proto.fluid(n.x & 15, n.y, n.z & 15)) === FLUID_WATER) expect([key(n), f]).toEqual([key(n), WATER_SOURCE]);
          if (fluidType(f) === FLUID_WATER) water++;
        }
      }
      expect(water, 'water around the pocket').toBeGreaterThanOrEqual(3);
      // The stone on the floor keeps its state and its column's cave byte (`replaceBlocks` keeps the cave entry).
      expect(p.store.blockAt(stone.x, stone.y, stone.z)).toBe(STONE);
      expect(fin.block(stone.x & 15, stone.y, stone.z & 15)).toBe(STONE);
      expect(fin.cave(stone.x & 15, stone.y, stone.z & 15)).toBe(proto.cave(stone.x & 15, stone.y, stone.z & 15));
      expect(caveKindOf(fin.cave(stone.x & 15, stone.y, stone.z & 15))).not.toBe(0);

      // The mesher (SP7a §6.2): each water neighbour of a dug voxel shows its face toward the pocket.
      const nb = p.store.neighborhood(cx, cz);
      const meshed = new Map<number, Set<string>>();
      let faces = 0;
      for (const v of dug) {
        for (let f = 0; f < 6; f++) {
          const [ox, oy, oz] = NORMAL[f]!;
          const n = { x: v.x + ox, y: v.y + oy, z: v.z + oz };
          if (edited.has(key(n)) || fluidType(p.store.fluidAt(n.x, n.y, n.z)) !== FLUID_WATER) continue;
          const sy = sectionOf(n);
          if (!meshed.has(sy)) meshed.set(sy, waterFaces(nb, cx, cz, sy));
          expect(meshed.get(sy), `the water at ${key(n)} draws no face toward the pocket`).toContain(`${key(n)},${OPPOSITE[f]}`);
          faces++;
        }
      }
      expect(faces).toBe(water);
      generatedValue = ((gen.block(reverted.x & 15, reverted.y, reverted.z & 15) << 8) | gen.fluid(reverted.x & 15, reverted.y, reverted.z & 15)) >>> 0;
    } finally {
      p.store.exitRead();
    }
    expect(fluidType(generatedValue & 255)).toBe(FLUID_WATER);

    // A revert of the middle dug voxel (the block history's undo of a dig): the generated value, its entry removed.
    const out = await p.edit([{ ...reverted, op: 'revert', value: 0, expect: (AIR << 8) | NO_FLUID }]);
    expect(out.ok).toBe(true);
    p.store.enterRead();
    try {
      expect(valueAt(p.store, reverted)).toBe(generatedValue);
    } finally {
      p.store.exitRead();
    }
    const diff = (await p.settle(p.simClient.diff(cx, cz), 'the column\'s diff'))!;
    const left = Array.from(diff.idx, (idx, k) => `${diff.sy[k]},${idx}`);
    expect(left).not.toContain(`${sectionOf(reverted)},${indexOf(reverted)}`);
    expect(left.length).toBe(3);
    expect((await p.flushNow()).ok).toBe(true);
  } finally {
    p.dispose();
  }

  // A reload reads the same: the reverted voxel's generated value, the other two dug voxels dry, the stone.
  const q = await openPersistWorld({ kv, worldId: id, rd: 4 });
  try {
    q.store.enterRead();
    try {
      expect(valueAt(q.store, reverted)).toBe(generatedValue);
      for (const v of [dug[0]!, dug[2]!]) expect([key(v), valueAt(q.store, v)]).toEqual([key(v), (AIR << 8) | NO_FLUID]);
      expect(q.store.blockAt(stone.x, stone.y, stone.z)).toBe(STONE);
    } finally {
      q.store.exitRead();
    }
  } finally {
    q.dispose();
  }
});
