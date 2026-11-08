/**
 * SP6a Task 8 (spec §1.3, §1.4; ruling P6): the continuity of the cave family taps across the depth bands' caps, the
 * spaghetti rarity edges and the surface ramp's ends, and each cap's closure distance.
 *
 * Continuity: each family tap is sampled on 1-block vertical lines at the corner lattice (lx, lz ∈ {0, 4, 8, 12}) of the
 * 64 × 64 positions around a cave class column (the 4 × 4 chunks cx − 1 … cx + 2), across each edge. A jump is the
 * change between two neighbouring samples; the family's local Lipschitz bound L is measured on the same grid with the
 * edge moved away (the band opened to −64 … 320; the two scales of a rarity edge made equal; the ramp's ends moved
 * 24 blocks deeper by `surfaceDepth` 32), and every jump stays within 2·L plus the Lipschitz slope of the term whose edge
 * is crossed (the cap: max(G_f / bandSpan, 128 / 8) per block; the ramp: 2·|ΔT| per block; a rarity blend:
 * 16·Σ_k |Δw_k|·|T_k| over the cell, per block). A switch (the master's noodle band adds 64 in one block) breaks it.
 *
 * Closure: with G_f and bandSpan at their defaults, each family's band is moved into the world by a params patch
 * (one end at a time, several placements pooled, each where the family has air around its class column) and, at each
 * distance d outside the edge, the share of the family's air with the band opened that survives the cap (the carve
 * rate against its value inside the band, on the same voxels); the closure distance is the y span over which it falls
 * from 90 % to 10 %, ≥ 4 blocks (spec §1.4). Each figure is printed for D25's record (Task 14 reads them).
 */
import { describe, expect, test } from 'vitest';
import { SPAGHETTI_BANDS, type SpaghettiBands } from '../../src/core/constants';
import { DEFAULTS } from '../../src/core/params/defaults';
import type { ParamsPatch } from '../../src/core/params/schema';
import { createDensityContext, type DensityContext } from '../../src/gen/density/context';
import { ctxFor } from '../harness/gen';

type Family = 'entrances' | 'cheese' | 'spaghetti3d' | 'spaghetti2d' | 'noodles';
const FAMILIES: readonly Family[] = ['entrances', 'cheese', 'spaghetti3d', 'spaghetti2d', 'noodles'];
const TAP: Readonly<Record<Family, string>> = { entrances: 'entrances', cheese: 'cheese', spaghetti3d: 'spag3d', spaghetti2d: 'spag2d', noodles: 'noodle' };
/** G_f, the tree's literals (SP6a §1.4). */
const GENTLE: Readonly<Record<Family, number>> = { entrances: 0.4, cheese: 5.8, spaghetti3d: 0.5, spaghetti2d: 0.3, noodles: 0.4 };
const S = DEFAULTS.caves.limits.bandSpan;
/**
 * The cave class columns of seed 42 (pinned in test/unit/liveness.test.ts): caverns, then tunnels. Task 38's tuned
 * defaults moved both; spaghetti 2D keeps its region at (4705, −24478), the tunnels' column before Task 38 and the
 * caverns' after it, whose layer lies in the slab below (the new tunnels' column holds little spaghetti 2D air there).
 */
const CAVERNS: readonly [number, number] = [4705, -24478];
const TUNNELS: readonly [number, number] = [-24763, -17996];
/** Where each family's air lies around its class column (the region, the y slab), and where its band is placed. */
const HOME: Readonly<Record<Family, { readonly region: readonly [number, number]; readonly band: readonly [number, number] }>> = {
  entrances: { region: CAVERNS, band: [56, 72] },
  cheese: { region: CAVERNS, band: [40, 64] },
  spaghetti3d: { region: TUNNELS, band: [-16, 16] },
  spaghetti2d: { region: CAVERNS, band: [-40, -36] },
  noodles: { region: CAVERNS, band: [40, 64] },
};

/** The 16 chunks around a class column (cx − 1 … cx + 2, cz − 1 … cz + 2). */
const chunksOf = ([cx, cz]: readonly [number, number]): Array<readonly [number, number]> => {
  const out: Array<readonly [number, number]> = [];
  for (let j = -1; j < 3; j++) for (let i = -1; i < 3; i++) out.push([cx + i, cz + j]);
  return out;
};
const LATTICE = [0, 4, 8, 12] as const;
const bandPatch = (f: Family, minY: number, maxY: number, extra: object = {}): ParamsPatch =>
  ({ caves: { [f]: { minY, maxY }, ...extra } }) as ParamsPatch;
const open = (f: Family): ParamsPatch => bandPatch(f, -64, 320);
const dcOf = (patch: ParamsPatch): DensityContext => createDensityContext(ctxFor('42', patch));

/** The tap on the vertical line (lx, lz) of chunk (cx, cz), y0 … y1. */
function lineOf(dc: DensityContext, tap: string, cx: number, cz: number, lx: number, lz: number, y0: number, y1: number): Float64Array {
  dc.column(cx, cz);
  const out = new Float64Array(y1 - y0 + 1);
  for (let y = y0; y <= y1; y++) out[y - y0] = dc.compiled.tapFn(tap, lx, y, lz);
  return out;
}
const jumps = (v: Float64Array): Float64Array => v.subarray(1).map((x, i) => Math.abs(x - v[i]!));
const maxOf = (v: ArrayLike<number>): number => { let m = 0; for (let i = 0; i < v.length; i++) m = Math.max(m, v[i]!); return m; };
const corner = (y: number): number => -64 + 8 * Math.floor((y + 64) / 8);

/** The worst excess of a jump over its bound on one line: max over steps of jump − bound (≤ 0 passes). */
interface Excess { worst: number; maxJump: number; maxOwn: number; lines: number }
const newExcess = (): Excess => ({ worst: -Infinity, maxJump: 0, maxOwn: 0, lines: 0 });

describe('continuity across the caps (SP6a spec §1.3, §1.4)', () => {
  /** The cap edges of one case: the capped and open contexts, the edges' y. */
  const cases: Array<{ readonly name: string; readonly f: Family; readonly capped: ParamsPatch; readonly edges: readonly number[] }> = [];
  for (const f of FAMILIES) {
    const [b0, b1] = HOME[f].band;
    cases.push({ name: `${f} band ${b0} … ${b1}`, f, capped: bandPatch(f, b0, b1), edges: [b0, b1, b0 - S, b1 + S] });
  }
  // The defaults' edges inside the world: cheese and spaghetti 3D below −56, the noodle's −60, 64 and 80.
  cases.push({ name: 'cheese at the defaults', f: 'cheese', capped: {}, edges: [-56] });
  cases.push({ name: 'spaghetti3d at the defaults', f: 'spaghetti3d', capped: {}, edges: [-56] });
  cases.push({ name: 'noodles at the defaults', f: 'noodles', capped: {}, edges: [-60, 64, 64 + S] });

  test('every jump across a cap edge stays within 2·L (the band opened) + the cap\'s slope max(G_f / bandSpan, 16)', () => {
    for (const c of cases) {
      const tap = TAP[c.f];
      const capped = dcOf(c.capped), own = dcOf(open(c.f));
      const capLip = Math.max(GENTLE[c.f] / S, 128 / 8);
      const ex = newExcess();
      for (const e of c.edges) {
        const y0 = Math.max(-63, e - 12), y1 = Math.min(319, e + 12);
        for (const [cx, cz] of chunksOf(HOME[c.f].region)) {
          for (const lz of LATTICE) for (const lx of LATTICE) {
            const d = jumps(lineOf(capped, tap, cx, cz, lx, lz, y0, y1));
            const L = maxOf(jumps(lineOf(own, tap, cx, cz, lx, lz, y0, y1)));
            ex.lines++;
            ex.maxJump = Math.max(ex.maxJump, maxOf(d));
            ex.maxOwn = Math.max(ex.maxOwn, L);
            for (let i = 0; i < d.length; i++) ex.worst = Math.max(ex.worst, d[i]! - (2 * L + capLip));
          }
        }
      }
      console.log(`continuity, cap edges, ${c.name} (edges ${c.edges.join(', ')}): ${ex.lines} lines, largest jump ${ex.maxJump.toFixed(3)}, largest L ${ex.maxOwn.toFixed(3)}, cap slope ${capLip}, worst excess ${ex.worst.toFixed(3)}`);
      expect([c.name, ex.worst <= 1e-9]).toEqual([c.name, true]);
    }
  });

  test('a step switch at a cap edge would fail the bound: the noodle with the master\'s +64 at y 64 (the test\'s own check)', () => {
    // The noodle tap with 64 added above y 64 (the master's band switch) on the same lines: some jump exceeds the bound.
    const own = dcOf(open('noodles'));
    let worst = -Infinity;
    for (const [cx, cz] of chunksOf(HOME.noodles.region)) {
      for (const lz of LATTICE) for (const lx of LATTICE) {
        const v = lineOf(own, 'noodle', cx, cz, lx, lz, 52, 76);
        const L = maxOf(jumps(v));
        const switched = v.map((x, i) => (52 + i > 64 ? x + 64 : x));
        worst = Math.max(worst, maxOf(jumps(switched)) - (2 * L + 128 / 8));
      }
    }
    expect(worst).toBeGreaterThan(0);
  });
});

/** The weights of the rarity blend at r (SP6a §1.3): w_k = step_k − step_{k+1}, step_z = clamp((r − zone_z.lo)·10, 0, 1). */
function weights(bands: SpaghettiBands, r: number): number[] {
  const step = (z: number): number => Math.min(1, Math.max(0, (r - bands.zones[z]![0]) * 10));
  const n = bands.zones.length + 1;
  return Array.from({ length: n }, (_, k) => (k === 0 ? 1 - step(0) : k === n - 1 ? step(k - 1) : step(k - 1) - step(k)));
}

describe('continuity across the spaghetti rarity edges (SP6a spec §1.3)', () => {
  const RARITY: ReadonlyArray<{ readonly f: Family; readonly bands: SpaghettiBands }> = [
    { f: 'spaghetti3d', bands: SPAGHETTI_BANDS.spaghetti3d },
    { f: 'spaghetti2d', bands: SPAGHETTI_BANDS.spaghetti2d },
  ];

  test('every jump in the cells where the rarity crosses an edge stays within 2·L (both scales equal) + 16·Σ_k |Δw_k|·|T_k| per block', () => {
    for (const { f, bands } of RARITY) {
      const tap = TAP[f];
      const dc = dcOf({});
      const scales = (DEFAULTS.caves[f] as { scales: Record<string, number> }).scales;
      const m = bands.zones.map((_, z) => z).concat(bands.zones.length).map((k) => scales[`s${k}`]!);
      const rarity = dc.noises(bands.rarity)!;
      const noises = bands.noises.map((id) => dc.noises(id)!);
      bands.zones.forEach(([zlo, zhi], e) => {
        const edge = (zlo + zhi) / 2;
        // The edge moved away: band e's scale on both sides, then band e + 1's.
        const same = (k: number): DensityContext => dcOf({ caves: { [f]: { scales: { [`s${e}`]: m[k]!, [`s${e + 1}`]: m[k]! } } } } as ParamsPatch);
        const owns = [same(e), same(e + 1)];
        const ex = newExcess();
        for (const [cx, cz] of [...chunksOf(TUNNELS), ...chunksOf(CAVERNS)]) {
          for (const lz of LATTICE) for (const lx of LATTICE) {
            const x = 16 * cx + lx, z = 16 * cz + lz;
            for (let k = 0; k < 48; k++) {
              const ya = -64 + 8 * k, yb = ya + 8;
              const ra = rarity.z3(x, ya, z), rb = rarity.z3(x, yb, z);
              if ((ra - edge) * (rb - edge) > 0) continue;
              // The crossing cell and its two neighbours.
              const y0 = Math.max(-63, ya - 8), y1 = Math.min(319, yb + 8);
              const d = jumps(lineOf(dc, tap, cx, cz, lx, lz, y0, y1));
              const L = Math.max(...owns.map((o) => maxOf(jumps(lineOf(o, tap, cx, cz, lx, lz, y0, y1)))));
              ex.lines++;
              ex.maxJump = Math.max(ex.maxJump, maxOf(d));
              ex.maxOwn = Math.max(ex.maxOwn, L);
              for (let i = 0; i < d.length; i++) {
                // The step y0 + i → y0 + i + 1 lies in the cell from corner c0 to c0 + 8.
                const c0 = corner(y0 + i), c1 = c0 + 8;
                const r0 = rarity.z3(x, c0, z), r1 = rarity.z3(x, c1, z);
                const w0 = weights(bands, r0), w1 = weights(bands, r1);
                let sw = 0;
                for (const N of noises) {
                  let s = 0;
                  for (let q = 0; q < m.length; q++) {
                    const t0 = m[q]! * Math.abs(N.z3(x / m[q]!, c0 / m[q]!, z / m[q]!));
                    const t1 = m[q]! * Math.abs(N.z3(x / m[q]!, c1 / m[q]!, z / m[q]!));
                    s += Math.abs(w1[q]! - w0[q]!) * Math.max(t0, t1);
                  }
                  sw = Math.max(sw, s);
                }
                ex.worst = Math.max(ex.worst, d[i]! - (2 * L + (16 * sw) / 8));
              }
            }
          }
        }
        console.log(`continuity, rarity edge ${edge} of ${f}: ${ex.lines} crossing cells, largest jump ${ex.maxJump.toFixed(3)}, largest L ${ex.maxOwn.toFixed(3)}, worst excess ${ex.worst.toFixed(3)}`);
        expect([f, edge, ex.lines > 0, ex.worst <= 1e-9]).toEqual([f, edge, true, true]);
      });
    }
  });
});

describe('continuity across the surface ramp\'s ends (SP6a spec §1.3, §1.4)', () => {
  test('every jump in the cells where T crosses 10 or −6 stays within 2·L (the ends moved by surfaceDepth 32) + 2·|ΔT| per block', () => {
    // The ramp clamp((surfaceDepth − T)·2, 0, 32) ends at T = surfaceDepth and T = surfaceDepth − 16.
    expect(DEFAULTS.caves.limits.surfaceDepth).toBe(10);
    for (const f of ['cheese', 'spaghetti3d', 'spaghetti2d'] as const) {
      const tap = TAP[f];
      const dc = dcOf({});
      const own = dcOf({ caves: { limits: { surfaceDepth: 32 } } });
      for (const end of [10, -6]) {
        const ex = newExcess();
        for (const [cx, cz] of chunksOf(HOME[f].region)) {
          dc.column(cx, cz);
          for (const lz of LATTICE) for (const lx of LATTICE) {
            for (let k = 0; k < 48; k++) {
              const ya = -64 + 8 * k, yb = ya + 8;
              dc.column(cx, cz);
              const ta = dc.compiled.tapFn('terrain', lx, ya, lz), tb = dc.compiled.tapFn('terrain', lx, yb, lz);
              if ((ta - end) * (tb - end) > 0) continue;
              const y0 = Math.max(-63, ya - 8), y1 = Math.min(319, yb + 8);
              const d = jumps(lineOf(dc, tap, cx, cz, lx, lz, y0, y1));
              const L = maxOf(jumps(lineOf(own, tap, cx, cz, lx, lz, y0, y1)));
              ex.lines++;
              ex.maxJump = Math.max(ex.maxJump, maxOf(d));
              ex.maxOwn = Math.max(ex.maxOwn, L);
              dc.column(cx, cz);
              for (let i = 0; i < d.length; i++) {
                const c0 = corner(y0 + i);
                const dT = Math.abs(dc.compiled.tapFn('terrain', lx, c0 + 8, lz) - dc.compiled.tapFn('terrain', lx, c0, lz));
                ex.worst = Math.max(ex.worst, d[i]! - (2 * L + (2 * dT) / 8));
              }
            }
          }
        }
        console.log(`continuity, ramp end T = ${end} of ${f}: ${ex.lines} crossing cells, largest jump ${ex.maxJump.toFixed(3)}, largest L ${ex.maxOwn.toFixed(3)}, worst excess ${ex.worst.toFixed(3)}`);
        expect([f, end, ex.lines > 0, ex.worst <= 1e-9]).toEqual([f, end, true, true]);
      }
    }
  });
});

describe('the closure distance of each cap (SP6a spec §1.4; ruling P6)', () => {
  /** The y slab around its class column where each family has air with its band opened (the profile of its region). */
  const SLAB: Readonly<Record<Family, readonly [number, number]>> = {
    entrances: [24, 103],
    cheese: [8, 103],
    spaghetti3d: [-56, 71],
    spaghetti2d: [-63, -17],
    noodles: [8, 95],
  };
  /** Distances measured outside the edge: −8 (inside the band, past the edge's cell) … 32 (closed: h ≥ 1/2 from 20). */
  const D0 = -8, D1 = 32;
  /**
   * The edge's placements, so y = e ± d stays in the slab: every 8 blocks (one corner alignment), and every 2 for
   * spaghetti 2D, whose layer is only about 40 blocks thick there (four alignments pooled).
   */
  const placements = (f: Family, end: 'minY' | 'maxY'): number[] => {
    const [a, b] = SLAB[f];
    const lo = end === 'maxY' ? a - D0 : a + D1, hi = end === 'maxY' ? b - D1 : b + D0;
    const out: number[] = [];
    for (let e = lo; e <= hi; e += f === 'spaghetti2d' ? 2 : 8) out.push(e);
    return out;
  };
  interface Closure { readonly at: readonly number[]; readonly ratio: readonly number[]; readonly air: readonly [number, number]; readonly d90: number; readonly d10: number; readonly span: number }
  const memo = new Map<string, Closure>();
  /**
   * The share of the family's air (with its band opened) that the cap at `end` leaves, at each distance d outside the
   * edge, pooled over the placements: the carve rate against its value inside the band, on the same voxels.
   */
  const closure = (f: Family, end: 'minY' | 'maxY'): Closure => {
    const key = `${f} ${end}`;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    const tap = TAP[f];
    const own = dcOf(open(f));
    const at = placements(f, end);
    const openAir = new Float64Array(D1 - D0 + 1), kept = new Float64Array(D1 - D0 + 1);
    for (const e of at) {
      const capped = dcOf(end === 'maxY' ? bandPatch(f, -64, e) : bandPatch(f, e, 320));
      for (const [cx, cz] of chunksOf(HOME[f].region)) {
        own.column(cx, cz);
        capped.column(cx, cz);
        for (let d = D0; d <= D1; d++) {
          const y = end === 'maxY' ? e + d : e - d;
          for (let lz = 0; lz < 16; lz++) {
            for (let lx = 0; lx < 16; lx++) {
              if (!(own.compiled.tapFn('precave', lx, y, lz) > 0) || !(own.compiled.tapFn(tap, lx, y, lz) <= 0)) continue;
              openAir[d - D0]++;
              if (capped.compiled.tapFn(tap, lx, y, lz) <= 0) kept[d - D0]++;
            }
          }
        }
      }
    }
    const ratio = Array.from(openAir, (n, i) => (n > 0 ? kept[i]! / n : NaN));
    const first = (q: number): number => D0 + ratio.findIndex((r) => r <= q);
    const d90 = first(0.9), d10 = first(0.1);
    const c: Closure = { at, ratio, air: [Math.min(...openAir), Math.max(...openAir)], d90, d10, span: d10 - d90 };
    console.log(`closure distance (SP6a §1.4, D25), ${f} ${end}: placements ${at.join(', ')}; ${c.air[0]} … ${c.air[1]} air voxels per distance; `
      + `90 % at d ${d90}, 10 % at d ${d10}: ${c.span} blocks; kept share by d ${D0} … ${D1}: ${ratio.map((r) => (Number.isNaN(r) ? '-' : r.toFixed(2))).join(' ')}`);
    memo.set(key, c);
    return c;
  };

  test('the cap leaves every air voxel inside the band past the edge\'s cell and closes every one by d 32, for each edge of each family', () => {
    expect(S).toBe(16);
    for (const f of FAMILIES) {
      for (const end of ['maxY', 'minY'] as const) {
        const c = closure(f, end);
        expect([f, end, c.at.length > 0, c.ratio[0], c.ratio.at(-1)]).toEqual([f, end, true, 1, 0]);
      }
    }
  });

  // One test per family and edge, the entrances' two included: at G_e 16 (before SP6a Task 14) they closed within 1 and
  // 2 blocks, since their air (the tube arm's and the scaled arm's, ruling R6) lies above −3 and the gentle part 16·g
  // closed it at g ≈ 3/16; D25's G_f rule set G_e to 0.4, the magnitude of their median tagged value.
  test.each(FAMILIES.flatMap((f) => [[f, 'maxY'], [f, 'minY']] as const))(
    'with G_f and bandSpan at their defaults, the carve rate of %s falls from 9 to 1 tenths of its band value over ≥ 4 blocks across its %s edge',
    (f, end) => {
      expect(closure(f, end).span).toBeGreaterThanOrEqual(4);
    },
  );
});
