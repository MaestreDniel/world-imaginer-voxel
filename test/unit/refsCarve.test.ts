/**
 * The global carver reference `referenceCarve` (SP6a spec §2.4, §10.1; `C7.carverReference`, `test/harness/refs.ts`):
 * - on a 4 × 4 region of seed '42' it equals the T stage's carver tags (the stored tag when 6-8, else 0) at every voxel
 *   of the region, which holds carved voxels;
 * - a path whose source chunk lies outside the region and whose ellipsoids reach both sides of the region's border
 *   carves, inside the region, exactly the voxels the stage carved there, with no per-column window;
 * - at a partly wet position (0 < wet′ < 1) under an entrance that breaches the top, σ_w reads the density top (the
 *   highest density-solid voxel), not the pre-cave top the entrance's tagged air raises: on a synthetic column carved by
 *   the stage's `carveColumn`, the reference equals the stage's tags, and at a voxel whose carve the two tops decide
 *   differently it gives the density top's answer.
 */
import { describe, expect, test } from 'vitest';
import { CARVER_CACHE_PATHS, CARVER_WINDOW_R, CAVE_KIND } from '../../src/core/constants';
import { resolveProfile } from '../../src/core/params/profiles';
import { seedFromInput } from '../../src/core/seed';
import { carveColumn, carvedKind, carveTest, densityTopColumn, densityTopOf, wetAt } from '../../src/gen/caves/carve';
import { createCarverCache } from '../../src/gen/caves/carverCache';
import { carverParamsOf, carverPath, type CarverKind } from '../../src/gen/caves/carvers';
import { buildColumnSample, newColumnSample } from '../../src/gen/column/columnStage';
import { createGenContext } from '../../src/gen/context';
import { AIR, BEDROCK, STONE } from '../../src/world/blocks/index';
import { referenceCarve } from '../harness/refs';
import { genRegion, type RegionResult, type RegionView } from '../harness/region';

const SEED = '42';
const PARAMS = resolveProfile('default');
const KINDS: readonly CarverKind[] = ['worm', 'ravine', 'undergroundWorm'];
const isCarver = (t: number): boolean => t === CAVE_KIND.worm || t === CAVE_KIND.ravine || t === CAVE_KIND.undergroundWorm;

/** The 4 × 4 region of seed '42' from chunk (0, 0), up to T, generated once. */
const REGION = { cx0: 0, cz0: 0, w: 4, h: 4 } as const;
let region: Promise<RegionResult> | null = null;
const generated = () => (region ??= genRegion({ seed: SEED, params: PARAMS, ...REGION, upTo: 'T', order: 'spiral', threads: 1 }));

/** `referenceCarve`'s index of world voxel (x, y, z) in a view's box. */
const refIndex = (v: Pick<RegionView, 'cx0' | 'cz0' | 'w' | 'h'>, x: number, y: number, z: number): number =>
  ((y + 64) * 16 * v.h + (z - 16 * v.cz0)) * 16 * v.w + (x - 16 * v.cx0);

describe('referenceCarve (SP6a spec §10.1, C7.carverReference)', () => {
  test('on a 4 × 4 region it equals the stage\'s carver tags at every voxel; the region holds carved voxels', async () => {
    const { view } = await generated();
    const ref = referenceCarve(view, SEED, PARAMS);
    expect(ref.length).toBe(64 * 64 * 384);
    let carved = 0;
    const diffs: string[] = [];
    for (let y = -64; y < 320; y++) {
      for (let z = 0; z < 64; z++) {
        for (let x = 0; x < 64; x++) {
          const t = view.tag(x, y, z);
          const kind = isCarver(t) ? t : 0;
          if (kind !== 0) carved++;
          const r = ref[refIndex(view, x, y, z)]!;
          if (r !== kind && diffs.length < 10) diffs.push(`(${x}, ${y}, ${z}) stored ${t}, reference ${r}`);
        }
      }
    }
    expect(diffs).toEqual([]);
    expect(carved).toBeGreaterThan(1000);
  });

  test('a path from a source outside the region that crosses its border carves inside the region exactly what the stage carved', async () => {
    const { view } = await generated();
    const ref = referenceCarve(view, SEED, PARAMS);
    const ctx = createGenContext(seedFromInput(SEED), PARAMS);
    const p = carverParamsOf(PARAMS);
    const x0 = 16 * REGION.cx0, z0 = 16 * REGION.cz0, x1 = x0 + 63, z1 = z0 + 63;
    // wet′ and the density top per position, from the region's density-solid voxels (as the stage's carve reads them).
    const solidAt = (x: number, y: number, z: number): boolean => view.block(x, y, z) !== AIR || isCarver(view.tag(x, y, z));
    const wet = new Float64Array(64 * 64);
    const top = new Int16Array(64 * 64);
    const s = newColumnSample();
    for (let cz = 0; cz < 4; cz++) {
      for (let cx = 0; cx < 4; cx++) {
        buildColumnSample(ctx, cx, cz, s);
        for (let q = 0; q < 256; q++) {
          const x = 16 * cx + (q & 15), z = 16 * cz + (q >> 4);
          wet[z * 64 + x] = wetAt(s, x, z);
          top[z * 64 + x] = densityTopOf((y) => solidAt(x, y, z), false);
        }
      }
    }
    let crossing = 0;
    let insideHits = 0;
    const bad: string[] = [];
    const R = CARVER_WINDOW_R;
    for (let sz = REGION.cz0 - R; sz < REGION.cz0 + REGION.h + R; sz++) {
      for (let sx = REGION.cx0 - R; sx < REGION.cx0 + REGION.w + R; sx++) {
        if (sx >= REGION.cx0 && sx < REGION.cx0 + REGION.w && sz >= REGION.cz0 && sz < REGION.cz0 + REGION.h) continue;
        for (const kind of KINDS) {
          const path = carverPath(ctx.seed, kind, sx, sz, p);
          if (path === null) continue;
          let inside = 0;
          let outside = 0;
          for (let e = 0; e < path.count; e++) {
            const [ex, ey, ez, rh, rv] = path.ell.subarray(6 * e, 6 * e + 5) as unknown as number[];
            for (let y = Math.max(-63, Math.floor(ey! - rv!) - 1); y <= Math.min(319, Math.ceil(ey! + rv!) + 1); y++) {
              for (let z = Math.floor(ez! - rh!) - 1; z <= Math.ceil(ez! + rh!) + 1; z++) {
                for (let x = Math.floor(ex! - rh!) - 1; x <= Math.ceil(ex! + rh!) + 1; x++) {
                  const inRegion = x >= x0 && x <= x1 && z >= z0 && z <= z1;
                  if (!inRegion) {
                    // Outside: the ellipsoid holds the voxel (dry: no σ_w).
                    if (outside === 0 && carveTest(p, path, e, x, y, z, 0, Number.NaN) === 1) outside++;
                    continue;
                  }
                  const q = (z - z0) * 64 + (x - x0);
                  if (!solidAt(x, y, z) || carveTest(p, path, e, x, y, z, wet[q]!, top[q]!) !== 1) continue;
                  inside++;
                  // The stage carved it (by this source or an earlier one), and the reference agrees.
                  const t = view.tag(x, y, z);
                  if (!isCarver(t) || ref[refIndex(view, x, y, z)] !== t) {
                    if (bad.length < 10) bad.push(`${kind} (${sx}, ${sz}) at (${x}, ${y}, ${z}): stored ${t}, reference ${ref[refIndex(view, x, y, z)]}`);
                  }
                }
              }
            }
          }
          if (inside > 0 && outside > 0) {
            crossing++;
            insideHits += inside;
          }
        }
      }
    }
    expect(bad).toEqual([]);
    expect(crossing, 'no path from outside the region carves on both sides of its border').toBeGreaterThan(0);
    expect(insideHits).toBeGreaterThan(0);
  });

  test('at a partly wet position under an entrance that breaches the top, σ_w reads the density top, not the pre-cave top', () => {
    // Column (−20, 0) of seed '42' holds partly wet positions (0 < wet′ < 1) that carvers pass under (found by a scan).
    const [cx, cz] = [-20, 0] as const;
    const ctx = createGenContext(seedFromInput(SEED), PARAMS);
    const p = carverParamsOf(PARAMS);
    const cache = createCarverCache(ctx, p, CARVER_CACHE_PATHS);
    const s = buildColumnSample(ctx, cx, cz, newColumnSample());
    /** The entrance's breach: its tagged air raises the pre-cave top this far above the density top. */
    const BREACH = 10;
    // A voxel whose carver kind the density top T and the pre-cave top T + 10 decide differently.
    let at: { q: number; x: number; y: number; z: number; T: number; wet: number; dense: number; preCave: number } | null = null;
    for (let q = 0; q < 256 && at === null; q++) {
      const x = 16 * cx + (q & 15), z = 16 * cz + (q >> 4);
      const wet = wetAt(s, x, z);
      if (!(wet > 0 && wet < 1)) continue;
      for (let T = -40; T <= 120 && at === null; T++) {
        for (let y = T - 45; y <= T; y++) {
          const dense = carvedKind(cache, p, s, x, y, z, () => T);
          const preCave = carvedKind(cache, p, s, x, y, z, () => T + BREACH);
          if (dense !== preCave) {
            at = { q, x, y, z, T, wet, dense, preCave };
            break;
          }
        }
      }
    }
    expect(at, 'no partly wet voxel whose carve depends on the top').not.toBeNull();
    const { q, x, y, z, T, wet, dense, preCave } = at!;
    expect(wet > 0 && wet < 1).toBe(true);
    // The synthetic column: density-solid from y −64 to T at every position; above T air, with the entrance's tagged air
    // from T + 1 to T + 10 at position q (density air that breaches the top). The stage's carve over it.
    const solid = new Uint8Array(98304);
    solid.fill(1, 0, 256 * (T + 65));
    const tops = new Int16Array(256);
    densityTopColumn(solid, false, tops);
    expect(tops[q]).toBe(T);
    const carved = solid.slice();
    const tags = new Uint8Array(98304);
    carveColumn(cache, p, s, cx, cz, carved, tops, tags);
    const idx = (wx: number, wy: number, wz: number): number => ((wy + 64) * 16 + (wz - 16 * cz)) * 16 + (wx - 16 * cx);
    const inBreach = (wx: number, wy: number, wz: number): boolean => ((wz - 16 * cz) << 4 | (wx - 16 * cx)) === q && wy > T && wy <= T + BREACH;
    const view: Pick<RegionView, 'cx0' | 'cz0' | 'w' | 'h' | 'block' | 'tag'> = {
      cx0: cx, cz0: cz, w: 1, h: 1,
      block: (wx, wy, wz) => (wy === -64 ? BEDROCK : carved[idx(wx, wy, wz)] === 1 ? STONE : AIR),
      tag: (wx, wy, wz) => (tags[idx(wx, wy, wz)] !== 0 ? tags[idx(wx, wy, wz)]! : inBreach(wx, wy, wz) ? CAVE_KIND.entrance : 0),
    };
    // The pre-cave top (the highest voxel solid or tagged) is the breach's top, above the density top.
    let preCaveTop = -65;
    for (let wy = 319; wy > -64 && preCaveTop === -65; wy--) if (view.block(x, wy, z) !== AIR || view.tag(x, wy, z) !== 0) preCaveTop = wy;
    expect(preCaveTop).toBe(T + BREACH);
    const ref = referenceCarve(view, SEED, PARAMS);
    // A 1 × 1 view's index is the fill's index.
    let first = -1;
    for (let v = 0; v < 98304 && first < 0; v++) if (ref[v] !== tags[v]) first = v;
    expect(first, 'the reference differs from the stage\'s carve').toBe(-1);
    expect(tags[idx(x, y, z)]).toBe(dense);
    expect(ref[idx(x, y, z)]).toBe(dense);
    expect(ref[idx(x, y, z)]).not.toBe(preCave);
  });
});
