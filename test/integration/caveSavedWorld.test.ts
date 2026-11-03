/**
 * A world saved before SP6a, opened with edits in what are now caves (the SP6a plan's Review Focus 2; spec §3.3,
 * §12.4, D20, D36): a GV5 record (schema 2, `params.density.defs` the SP5c default tree of
 * `test/fixtures/sp5c-density-trees.json`) whose `ColumnDiffV1` places stone at a voxel the T stage now tags cheese and
 * digs a voxel T leaves solid, opened through `openPersistWorld` (the page's open on the real stack). The world opens
 * with today's tree and the older-generator flag; the edits read back; the placed stone keeps the T stage's tag in the
 * final set (`replaceBlocks` keeps the section's cave entry) and the dug voxel's tag is 0 (it was rock: not cave).
 * Task 17 adds the X-ray's half: `meshXray` over that section, walls toward the stone and none toward the dug voxel.
 */
import { expect, test } from 'vitest';
import { CAVE_KIND } from '../../src/core/constants';
import { colKey } from '../../src/core/coords';
import { parseHex64 } from '../../src/core/hash';
import { canonicalJSON } from '../../src/core/params/canonical';
import { DEFAULT_DENSITY_TREE } from '../../src/core/params/defaultTrees';
import type { JsonObject } from '../../src/core/params/migrate';
import { terrainStage } from '../../src/gen/pipeline/terrainStage';
import { encodeColumnDiff } from '../../src/persist/diffCodec';
import { createMemoryKV } from '../../src/persist/memory';
import { createSaves, loadParams, newState } from '../../src/persist/saves';
import { DEFAULT_MAP_STATE, openMapSession } from '../../src/ui/map/mapState';
import { STATE_BOUNDS } from '../../src/ui/world/stateBounds';
import { newWorldRecord, OLDER_GENERATOR_NOTICE } from '../../src/ui/world/worldPage';
import { AIR, STONE } from '../../src/world/blocks/index';
import { createStore } from '../../src/world/store/store';
import { ctxFor } from '../harness/gen';
import { openPersistWorld } from '../harness/persistWorld';
import { sp5cTrees } from '../harness/sp5cTrees';

const MiB = 1 << 20;
/** A generator key no world of today's generator has (the record's, from SP5c). */
const OLD = 'f00df00df00df00d';

interface Voxel { readonly x: number; readonly y: number; readonly z: number }

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
              if (cheese === null && v.cave(lx, y, lz) === CAVE_KIND.cheese && v.block(lx, y, lz) === AIR) cheese = at;
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

test('a GV5 world with edits in what are now caves opens with the caves: today\'s tree, the older-generator flag, the edits read back, the stone keeps its cheese tag and the dug voxel has none (Review Focus 2)', async () => {
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
      expect(fin.cave(cheese.x & 15, cheese.y, cheese.z & 15)).toBe(CAVE_KIND.cheese);
      expect(fin.cave(rock.x & 15, rock.y, rock.z & 15)).toBe(0);
      expect(fin.block(cheese.x & 15, cheese.y, cheese.z & 15)).toBe(STONE);
    } finally {
      p.store.exitRead();
    }
  } finally {
    p.dispose();
  }
});
