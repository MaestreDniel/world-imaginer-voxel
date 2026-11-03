/**
 * The two default trees as data (SP3d spec §2): the defaults of the `json` leaves `density.defs` and `surface.rules`.
 * They live in core because the schema needs them as leaf defaults and core cannot import gen (master §1); they are
 * typed as `JsonValue` and gen narrows them after its own validation (tier 2).
 *
 * Each is built at module load as tier 1's registered, deep-frozen, key-sorted clone (`checkJson`, §1.7), and the load
 * throws on any issue: so `buildSchema` keeps it by identity, `checkJson` returns it as itself, `canonicalJSON` prints
 * it from its cache, and the resolvers' memo (keyed by the frozen source) hits on every context. The literals below are
 * written with `op` / `kind` first for reading; key order is not semantic.
 */
import { SPAGHETTI_BANDS, type SpaghettiBands } from '../constants';
import { checkJson, type JsonFormat, type JsonValue } from './json';
import type { Issue } from './kit';

/**
 * Tier 1's registered clone of a default or preset tree (SP3e spec §1.1: `presetTrees.ts` registers the preset trees
 * through it); throws on any issue (a built-in tree that fails tier 1 is a bug).
 */
export function registeredTree(tree: JsonValue, leaf: string, format: JsonFormat): JsonValue {
  const issues: Issue[] = [];
  const clone = checkJson(tree, leaf, issues, format);
  if (clone === undefined) throw new Error(`the default ${leaf} tree fails tier 1: ${issues.map((i) => `${i.path} ${i.code}`).join(', ')}`);
  return clone;
}

// ---------------------------------------------------------------- the cave terms (SP6a spec §1.1-§1.2)
// Non-exported builders of the cave subtrees: each call returns fresh nodes, so the data stays one literal tree (tier 1
// clones it); every sum and product stays left-nested in the written order (IEEE addition is not associative).

const c = (v: number): JsonValue => ({ op: 'const', v });
const param = (path: string): JsonValue => ({ op: 'param', path });
const add = (a: JsonValue, b: JsonValue): JsonValue => ({ op: 'add', a, b });
const mul = (a: JsonValue, b: JsonValue): JsonValue => ({ op: 'mul', a, b });
const min = (a: JsonValue, b: JsonValue): JsonValue => ({ op: 'min', a, b });
const max = (a: JsonValue, b: JsonValue): JsonValue => ({ op: 'max', a, b });
const neg = (x: JsonValue): JsonValue => ({ op: 'neg', x });
const abs = (x: JsonValue): JsonValue => ({ op: 'abs', x });
const square = (x: JsonValue): JsonValue => ({ op: 'square', x });
/** x³ as `mul(square(x), x)` (the pillars' thickness factor's form), each x a fresh copy from `x()`. */
const cube = (x: () => JsonValue): JsonValue => mul(square(x()), x());
const clamp = (x: JsonValue, lo: number, hi: number): JsonValue => ({ op: 'clamp', x, lo, hi });
/** `rangeChoice(x, lo, hi, a, b)`: `a` where lo ≤ x < hi, else `b`; `hi` a literal or a parameter ref. */
const rangeChoice = (x: JsonValue, lo: number, hi: number | { readonly param: string }, inside: JsonValue, outside: JsonValue): JsonValue =>
  ({ op: 'rangeChoice', x, lo, hi, inside, outside });
const noise = (id: string): JsonValue => ({ op: 'noise', id });
const noise2 = (id: string): JsonValue => ({ op: 'noise2', id });
const interpolated = (x: JsonValue): JsonValue => ({ op: 'interpolated', x });
const tap = (name: string, x: JsonValue): JsonValue => ({ op: 'tap', name, x });
const ref = (name: string): JsonValue => ({ op: 'ref', name });
/** The terrain body T at the corner (`ref body`), CSE-shared with the `terrain` tap's child (SP6a Spec correction 6). */
const body = (): JsonValue => ref('body');

/** fl(v) = max(v, −48): the family floor F = 48 (§1.4), so the caps close every family over the leaves' static ranges. */
const fl = (v: JsonValue): JsonValue => max(v, c(-48));
/** sky(v) = rangeChoice(T, −1e9, −8, 32, v): the deep families skipped at corners 8 or more above the surface. */
const sky = (v: JsonValue): JsonValue => rangeChoice(body(), -1e9, -8, c(32), v);
/** ramp = clamp((surfaceDepth − T)·2, 0, 32): 0 at T ≥ surfaceDepth, 16 at the surface, 32 from 8 above it (D4). */
const ramp = (): JsonValue => clamp(mul(add(param('caves.limits.surfaceDepth'), neg(body())), c(2)), 0, 32);
/** The position's y (the corner's inside an `interpolated` slot, the voxel's outside). */
const y = (): JsonValue => ({ op: 'y' });
const recip = (x: JsonValue): JsonValue => ({ op: 'recip', x });
/** s = `caves.limits.bandSpan`, the gentle part's span (1 … 32 blocks). */
const bandSpan = (): JsonValue => param('caves.limits.bandSpan');
/**
 * The gentle rise G_f of each family's cap (SP6a §1.4; tree literals, about the family's typical air depth: its value
 * at the median carved voxel): the blobby families' air values are about −5 to −16, the ridged ones' −1 to −3.
 */
const CAP_GENTLE = { entrances: 16, cheese: 16, spaghetti3d: 2.4, spaghetti2d: 2.4, noodles: 2.4 } as const;
/** capTop = `caves.limits.capTop` (180 … 344; the default 344, above the world's top y 319, has no effect). */
const capTop = (): JsonValue => param('caves.limits.capTop');
/**
 * cap_f = G_f·min(1, g_f + g_i) + 128·min(1, h_f + h_i) (SP6a §1.4, D2, D8), for the family whose depth band is
 * `caves.<family>.minY` … `.maxY`:
 * - the depth band: g_f = clamp((minY − y)·(1/s), 0, 1) + clamp((y − maxY)·(1/s), 0, 1) rises from 0 to 1 over the s
 *   blocks outside the band (the family narrows), h_f = clamp((minY − s − y)·(1/8), 0, 1) + clamp((y − maxY − s)·(1/8),
 *   0, 1) over the next 8 (it closes: wherever h_f ≥ 1/2 the slot is ≥ −48 + 64 > 0 over every leaf value, the floor
 *   `fl` bounding the family below);
 * - the island cap: g_i = clamp((y − capTop + 8 + s)·(1/s), 0, 1), h_i = clamp((y − capTop + 8)·(1/8), 0, 1), so with
 *   capTop 180 (floating_islands) the families narrow over y 156 … 172 and every corner at y ≥ 176 has h_i ≥ 1/2: no
 *   noise cave air at y ≥ 176, below ISLAND_RUN_MIN_BOTTOM (D8). At the default 344 both are 0 at every corner (y ≤ 320) while bandSpan ≤ 16.
 * Written with `recip(param …)` and `y`, not `slide` knots: a knot's y is a literal or one ref and the knots must
 * increase over the refs' static ranges, which the overlapping minY / maxY ranges break.
 */
const cap = (family: keyof typeof CAP_GENTLE): JsonValue => {
  const minY = (): JsonValue => param(`caves.${family}.minY`);
  const maxY = (): JsonValue => param(`caves.${family}.maxY`);
  const g = add(
    clamp(mul(add(minY(), neg(y())), recip(bandSpan())), 0, 1),
    clamp(mul(add(y(), neg(maxY())), recip(bandSpan())), 0, 1));
  const h = add(
    clamp(mul(add(add(minY(), neg(bandSpan())), neg(y())), c(0.125)), 0, 1),
    clamp(mul(add(add(y(), neg(maxY())), neg(bandSpan())), c(0.125)), 0, 1));
  const gi = clamp(mul(add(add(add(y(), neg(capTop())), c(8)), bandSpan()), recip(bandSpan())), 0, 1);
  const hi = clamp(mul(add(add(y(), neg(capTop())), c(8)), c(0.125)), 0, 1);
  return add(mul(c(CAP_GENTLE[family]), min(c(1), add(g, gi))), mul(c(128), min(c(1), add(h, hi))));
};
/** rough = (−0.05 − 0.05·Nrm)·(−0.4 + |Nr|). */
const rough = (): JsonValue => mul(add(c(-0.05), mul(c(-0.05), noise('roughnessMod'))), add(c(-0.4), abs(noise('roughness'))));

/**
 * E = tap entrances(interpolated(fl(16·min(Ne·(1/6) + offset + yGrad(−10 → 0.3, 30 → 0), rough + clamp(max(|E1|,
 * |E2|) − threshold, −1, 1))) + cap_e)): no `sky` and no `ramp` (the master's "entrances NOT depth-ramped"). Ne is a unit-sd
 * noise, so its arm is scaled by 1/6 (written `recip(const 6)`, as the cheese roof's 1/24): the default offset 0.37
 * opens where Ne < −2.22 (SP6a spec §1.2).
 */
const entrances = (): JsonValue => tap('entrances', interpolated(add(fl(mul(c(16), min(
  add(add(mul(noise('entrance'), { op: 'recip', x: c(6) }), param('caves.entrances.offset')), { op: 'slide', x: c(1), knots: [[-10, 0.3], [30, 0]] }),
  add(rough(), clamp(add(max(abs(noise('entranceA')), abs(noise('entranceB'))), neg(param('caves.entrances.threshold'))), -1, 1)),
))), cap('entrances'))));

/**
 * C = tap cheese(interpolated(sky(fl(16·(layerAmp·L² + clamp(Nch + offset − regional·Nra, −1, 1) + clamp((roofDepth −
 * T)·(1/24), 0, 0.5))) + ramp + cap_c))): the master's cheese with its roof term; `regional` lowers the threshold where
 * Nra is high (D3).
 */
const cheese = (): JsonValue => tap('cheese', interpolated(sky(add(add(fl(mul(c(16), add(add(
  mul(param('caves.cheese.layerAmp'), square(noise('layer'))),
  clamp(add(add(noise('cheese'), param('caves.cheese.offset')), neg(mul(param('caves.cheese.regional'), noise2('cheeseRegional')))), -1, 1)),
  clamp(mul(add(param('caves.cheese.roofDepth'), neg(body())), { op: 'recip', x: c(24) }), 0, 0.5),
))), ramp()), cap('cheese')))));

/** 0.55 + 0.55·thk_p, the pillars' thickness factor (cubed as `mul(square(x), x)`). */
const pillarThickness = (): JsonValue => add(c(0.55), mul(c(0.55), noise('pillarThickness')));
/** P = tap pillars(interpolated(16·(2·Np − 1 − rare)·(0.55 + 0.55·thk_p)³)), written once in `defs.pillars`. */
const pillars = (): JsonValue => tap('pillars', interpolated(mul(
  mul(c(16), add(add(mul(c(2), noise('pillar')), c(-1)), neg(noise('pillarRare')))),
  mul(square(pillarThickness()), pillarThickness()),
)));
/**
 * keep = rangeChoice(P / 16, −1e9, threshold, −1e6, P): −1e6 (no effect under `max`) where P / 16 < threshold, else P
 * (≥ 16·threshold, rock). Spec §1.1's `rangeChoice(P, −1e9, 0.48, −1e6, P)` with its bound 0.48 = 16 × 0.03 read from the
 * leaf: a bound is a literal or one ref, so P is scaled back by the exact 1/16. Both `ref pillars` read one tap.
 */
const keep = (): JsonValue => rangeChoice(mul(ref('pillars'), c(0.0625)), -1e9, { param: 'caves.pillars.threshold' }, c(-1000000), ref('pillars'));

/**
 * The rarity blend of a spaghetti family (SP6a §1.3): `rmS(N) = Σ_k w_k(r)·m_k·|noiseScaled(N, m_k)|` over the bands of
 * its rarity noise r, m_k the leaf `<scales>.s<k>`. Each band edge e is written as its blend zone [e − 0.05, e + 0.05)
 * (`SPAGHETTI_BANDS`' literals, so no rounding moves an edge); with `step_e(r) = clamp((r − (e − 0.05))·10, 0, 1)` (0
 * below the zone, 1 from its top, linear inside), w_0 = 1 − step_1, w_k = step_k − step_{k+1} and w_last = step_last: w_k is 1 inside band
 * k, the two neighbours blend linearly within ±0.05 of an edge and the weights sum to 1. Each band's term sits under
 * `rangeChoice(r, lo_k, hi_k, (w_k·m_k)·|noiseScaled(N, m_k)|, 0)` on band k widened by 0.05 on each side, exactly where
 * its weight can be non-zero, so its `noiseScaled` is evaluated only there ("both evaluated only there"); the terms add
 * left-nested, and outside every blend zone the sum is the band's plain value m_k·|noiseScaled(N, m_k)| bit for bit.
 */
const rarityBlend = (id: string, bands: SpaghettiBands): JsonValue => {
  const zones = bands.zones;
  const r = (): JsonValue => noise(bands.rarity);
  const step = (z: number): JsonValue => clamp(mul(add(r(), c(-zones[z]![0])), c(10)), 0, 1);
  const n = zones.length + 1;
  let sum: JsonValue | null = null;
  for (let k = 0; k < n; k++) {
    const w = k === 0 ? add(c(1), neg(step(0))) : k === n - 1 ? step(k - 1) : add(step(k - 1), neg(step(k)));
    const m = `${bands.scales}.s${k}`;
    const lo = k === 0 ? -1e9 : zones[k - 1]![0], hi = k === n - 1 ? 1e9 : zones[k]![1];
    const term = rangeChoice(r(), lo, hi, mul(mul(w, param(m)), abs({ op: 'noiseScaled', id, s: { param: m } })), c(0));
    sum = sum === null ? term : add(sum, term);
  }
  return sum!;
};
const S3_BANDS = SPAGHETTI_BANDS.spaghetti3d;
const S2_BANDS = SPAGHETTI_BANDS.spaghetti2d;

/**
 * S3 = tap spag3d(interpolated(sky(fl(16·(rough + clamp(max(rmS(S1), rmS(S2)) − thickness − thicknessVar·thk_s −
 * regional·Nrb, −1, 1))) + ramp + cap_s3))): Minecraft's 3D spaghetti with continuous rarity bands (SP6a §1.2-§1.3);
 * S1 and S2 share the rarity noise.
 */
const spag3d = (): JsonValue => tap(S3_BANDS.tap, interpolated(sky(add(add(fl(mul(c(16), add(rough(), clamp(add(add(add(
  max(
    rarityBlend(S3_BANDS.noises[0]!, S3_BANDS),
    rarityBlend(S3_BANDS.noises[1]!, S3_BANDS),
  ),
  neg(param('caves.spaghetti3d.thickness'))),
  neg(mul(param('caves.spaghetti3d.thicknessVar'), noise('spag3dThickness')))),
  neg(mul(param('caves.spaghetti3d.regional'), noise2('spagRegional')))), -1, 1)))), ramp()), cap('spaghetti3d')))));

/** tm = −thickness − 0.35·Nthk, spaghetti 2D's thickness term (spec §1.2's `−0.95 − 0.35·Nthk`, 0.95 the leaf). */
const spag2dTm = (): JsonValue => add(neg(param('caves.spaghetti2d.thickness')), mul(c(-0.35), noise('spag2dThickness')));
/**
 * S2 = tap spag2d(interpolated(sky(fl(16·clamp(max(rmS2(S2d) + 0.083·tm, (|layerAmp·Nel + yGrad(−64 → 8, 320 → −40)| +
 * tm)³), −1, 1)) + ramp + cap_s2))): flat tunnels along a layer that slopes down by one block in eight (SP6a §1.2).
 */
const spag2d = (): JsonValue => tap(S2_BANDS.tap, interpolated(sky(add(add(fl(mul(c(16), clamp(max(
  add(rarityBlend(S2_BANDS.noises[0]!, S2_BANDS), mul(c(0.083), spag2dTm())),
  cube(() => add(abs(add(mul(param('caves.spaghetti2d.layerAmp'), noise2('spag2dElevation')), { op: 'slide', x: c(1), knots: [[-64, 8], [320, -40]] })), spag2dTm())),
), -1, 1))), ramp()), cap('spaghetti2d')))));

/**
 * nb(N, c) = rangeChoice(y − maxY_n, −1e9, 40, rangeChoice(minY_n − y, −1e9, 40, N, c), c): a noodle noise only at
 * corners within 40 blocks of the noodle band (lever 3, SP6a §1.1; 40 = bandSpan's static maximum 32 + 8), the constant
 * c (which closes the tube) outside; minY_n, maxY_n the leaves `caves.noodles.minY` / `.maxY` (y −60 … 64). The bound 40
 * stays a literal (a `rangeChoice` bound is a literal or one ref): beyond bandSpan + 8 ≤ 40 blocks outside the band the
 * steep part of the noodle's cap has closed it already.
 */
const nb = (x: JsonValue, cst: number): JsonValue =>
  rangeChoice(add(y(), neg(param('caves.noodles.maxY'))), -1e9, 40,
    rangeChoice(add(param('caves.noodles.minY'), neg(y())), -1e9, 40, x, c(cst)), c(cst));
/**
 * noodle = tap noodle(fl(16·(−thickness − 0.025·Kn + ridgeMul·max(|An|, |Bn|) + 4·max(0, −Nn))) + cap_n), combined at
 * voxel level (outside `interpolated`, its cap read at the voxel's y) from four slots: Nn = interpolated(nb(Nt −
 * regional·Nrb, −1)), Kn = interpolated(nb(thk_n, 0)), An = interpolated(nb(Ra, 1)), Bn = interpolated(nb(Rb, 1)). The
 * toggle `+ 4·max(0, −Nn)` narrows the tube and closes it by Nn ≈ −0.019 (SP6a §1.3).
 */
const noodle = (): JsonValue => tap('noodle', add(fl(mul(c(16), add(add(add(
  neg(param('caves.noodles.thickness')),
  mul(c(-0.025), interpolated(nb(noise('noodleThickness'), 0)))),
  mul(param('caves.noodles.ridgeMul'), max(abs(interpolated(nb(noise('noodleRidgeA'), 1))), abs(interpolated(nb(noise('noodleRidgeB'), 1)))))),
  mul(c(4), max(c(0), neg(interpolated(nb(add(noise('noodleToggle'), neg(mul(param('caves.noodles.regional'), noise2('spagRegional')))), -1)))))))), cap('noodles')));

/** The caves slot (SP6a §1.1): max(min(E, C, S3, S2), keep), the mins left-nested in that order. */
const caves = (): JsonValue => max(min(min(min(entrances(), cheese()), spag3d()), spag2d()), keep());

/**
 * The default density expression `{root, defs}` (SP3d spec §2.1; SP3b spec §3.1; SP6a spec §1.1). `defs.body` is the
 * terrain body `defaultDensityExpr` builds under its `interpolated`, with exactly three substitutions in the body and
 * the detail term, `C(1 / clampSigma)` → `recip(param density.noises.jag.clampSigma)`, `C(detailAmpLo)` → `param
 * density.detailAmpLo` and `C(detailAmpHi − detailAmpLo)` → `add(param density.detailAmpHi, neg(param
 * density.detailAmpLo))` (`hi + (−lo)` is `hi − lo` for every pair of doubles, §1.4). The sums stay left-nested in the
 * written order (IEEE addition is not associative). `SLIDE`, the floor and ceiling terms and `islands` = −1e6 are data.
 *
 * The root (SP6a §1.1, D17) is
 * `max(min(min(tap precave(add(tap terrain(interpolated(ref body)), detailG)), caves), noodle), tap islands(−1e6))`:
 * `root.a.a.a` is the `precave` tap (the pre-cave density T + detailG that the cave tag reads, SP6a §3.2),
 * `root.a.a.a.x.a` the `terrain` tap, `root.a.a.a.x.b` detailG (the detail term is its `inside`), `root.a.a.b` the caves
 * slot max(min(E, C, S3, S2), keep) (the taps `entrances` `root.a.a.b.a.a.a.a`, `cheese` `root.a.a.b.a.a.a.b`, `spag3d`
 * `root.a.a.b.a.a.b`, `spag2d` `root.a.a.b.a.b`), `root.a.b` the `noodle` tap and `root.b` the islands tap.
 */
export const DEFAULT_DENSITY_TREE: JsonValue = registeredTree(
  {
    root: { op: 'max',
      a: { op: 'min',
        a: { op: 'min',
          a: { op: 'tap', name: 'precave',
            x: { op: 'add',
              a: { op: 'tap', name: 'terrain', x: { op: 'interpolated', x: { op: 'ref', name: 'body' } } },
              // detailG = rangeChoice(interpolated(ref body), −1e9, 16, detail, 0): skipped where T ≥ 16 (SP6a §1.1, Spec
              // correction 6: `interpolated(ref body)` is CSE-shared with the terrain tap's child, a tap name is unique).
              b: rangeChoice(interpolated(body()), -1e9, 16, { op: 'mul',
                a: { op: 'noise', id: 'detail' },
                b: { op: 'add',
                  a: { op: 'param', path: 'density.detailAmpLo' },
                  b: { op: 'mul',
                    a: { op: 'add',
                      a: { op: 'param', path: 'density.detailAmpHi' },
                      b: { op: 'neg', x: { op: 'param', path: 'density.detailAmpLo' } },
                    },
                    b: { op: 'clamp',
                      x: { op: 'mul',
                        a: { op: 'add', a: { op: 'col', field: 'E' }, b: { op: 'const', v: 1 } },
                        b: { op: 'const', v: 0.5 },
                      },
                      lo: 0,
                      hi: 1,
                    },
                  },
                },
              }, c(0)),
            },
          },
          b: caves(),
        },
        b: noodle(),
      },
      b: { op: 'tap', name: 'islands', x: { op: 'const', v: -1000000 } },
    },
    defs: {
      pillars: pillars(),
      body: { op: 'add',
        a: { op: 'add',
          a: { op: 'add',
            a: { op: 'add',
              a: { op: 'add',
                a: { op: 'col', field: 'offset' },
                b: { op: 'mul',
                  a: { op: 'col', field: 'jag' },
                  b: { op: 'square',
                    x: { op: 'add',
                      a: { op: 'const', v: 1 },
                      b: { op: 'neg',
                        x: { op: 'abs',
                          x: { op: 'mul',
                            a: { op: 'noise2', id: 'jag' },
                            b: { op: 'recip', x: { op: 'param', path: 'density.noises.jag.clampSigma' } },
                          },
                        },
                      },
                    },
                  },
                },
              },
              b: { op: 'neg', x: { op: 'y' } },
            },
            b: { op: 'mul',
              a: { op: 'col', field: 'sigma' },
              b: { op: 'slide', x: { op: 'noise', id: 'overhang' }, knots: [[-64, 0], [-40, 1], [240, 1], [320, 0]] },
            },
          },
          b: { op: 'mul',
            a: { op: 'const', v: 2 },
            b: { op: 'max',
              a: { op: 'const', v: 0 },
              b: { op: 'add', a: { op: 'const', v: -56 }, b: { op: 'neg', x: { op: 'y' } } },
            },
          },
        },
        b: { op: 'neg',
          x: { op: 'mul',
            a: { op: 'const', v: 2 },
            b: { op: 'max', a: { op: 'const', v: 0 }, b: { op: 'add', a: { op: 'y' }, b: { op: 'const', v: -296 } } },
          },
        },
      },
    },
  },
  'density.defs',
  'density',
);

/**
 * The default surface-rule tree (SP3d spec §2.2; SP3c spec §4): `defaultSurfaceRules`' tree, which is
 * `test/fixtures/sp3c-default-rules.json` at the defaults, with its four parameter reads written as refs at the 15
 * places the builder writes them: the patch condition's `min` → `{param: 'surface.patchThreshold'}` (10), the negated
 * patch condition's `max` → `{param: 'surface.patchThreshold', neg: true}` (2, resolved as `0 − v`, never −0),
 * `steep.min` → `surface.cliffSteep`, `yAbove.minY` → `surface.cliffMinY` and `temperatureBelow.t` →
 * `surface.snowline`. Every other number is the fixture's literal (the gradient bounds −64, −59, 0, 8; the patch
 * limits −8 and 8; the `stoneDepth` and `water` offsets). The builder shares node objects; the data does not.
 */
export const DEFAULT_SURFACE_RULES: JsonValue = registeredTree(
  { kind: 'sequence',
    rules: [
      { kind: 'condition',
        if: { kind: 'verticalGradient', trueAtAndBelow: -64, falseAtAndAbove: -59 },
        then: { kind: 'block', state: 'bedrock' },
      },
      { kind: 'condition',
        if: { kind: 'skyOpen' },
        then: { kind: 'sequence',
          rules: [
            { kind: 'condition',
              if: { kind: 'not', if: { kind: 'water', offset: 0, runTop: false } },
              then: { kind: 'condition',
                if: { kind: 'stoneDepth', side: 'floor', offset: 0, addSurfaceDepth: true },
                then: { kind: 'sequence',
                  rules: [
                    { kind: 'condition',
                      if: { kind: 'biome', biomes: ['warm_ocean', 'beach', 'snowy_beach'] },
                      then: { kind: 'block', state: 'sand' },
                    },
                    { kind: 'condition',
                      if: { kind: 'biome', biomes: ['deep_ocean', 'frozen_ocean'] },
                      then: { kind: 'block', state: 'gravel' },
                    },
                    { kind: 'condition',
                      if: { kind: 'biome', biomes: ['river', 'frozen_river', 'swamp'] },
                      then: { kind: 'condition',
                        if: { kind: 'noiseThreshold', noise: 'surface.noises.patch',
                          min: { param: 'surface.patchThreshold' },
                          max: 8,
                        },
                        then: { kind: 'block', state: 'clay' },
                      },
                    },
                    { kind: 'condition',
                      if: { kind: 'lake' },
                      then: { kind: 'condition',
                        if: { kind: 'noiseThreshold', noise: 'surface.noises.patch',
                          min: { param: 'surface.patchThreshold' },
                          max: 8,
                        },
                        then: { kind: 'block', state: 'clay' },
                      },
                    },
                    { kind: 'condition',
                      if: { kind: 'biome', biomes: ['river', 'frozen_river'] },
                      then: { kind: 'block', state: 'dirt' },
                    },
                    { kind: 'condition',
                      if: { kind: 'lake' },
                      then: { kind: 'condition',
                        if: { kind: 'water', offset: -2, runTop: true },
                        then: { kind: 'block', state: 'sand' },
                      },
                    },
                    { kind: 'condition',
                      if: { kind: 'not', if: { kind: 'water', offset: -10, runTop: true } },
                      then: { kind: 'block', state: 'gravel' },
                    },
                    { kind: 'condition',
                      if: { kind: 'water', offset: -10, runTop: false },
                      then: { kind: 'block', state: 'sand' },
                    },
                    { kind: 'block', state: 'gravel' },
                  ],
                },
              },
            },
            { kind: 'condition',
              if: { kind: 'steep', min: { param: 'surface.cliffSteep' } },
              then: { kind: 'condition',
                if: { kind: 'yAbove', minY: { param: 'surface.cliffMinY' }, runTop: true },
                then: { kind: 'condition',
                  if: { kind: 'stoneDepth', side: 'floor', offset: 0, addSurfaceDepth: true },
                  then: { kind: 'sequence',
                    rules: [
                      { kind: 'condition',
                        if: { kind: 'biome', biomes: ['frozen_peaks'] },
                        then: { kind: 'block', state: 'packed_ice' },
                      },
                      { kind: 'block', state: 'stone' },
                    ],
                  },
                },
              },
            },
            { kind: 'condition',
              if: { kind: 'stoneDepth', side: 'floor', offset: 0, addSurfaceDepth: false },
              then: { kind: 'condition',
                if: { kind: 'temperatureBelow', t: { param: 'surface.snowline' } },
                then: { kind: 'block', state: 'snow_block' },
              },
            },
            { kind: 'condition',
              if: { kind: 'stoneDepth', side: 'floor', offset: 0, addSurfaceDepth: true },
              then: { kind: 'sequence',
                rules: [
                  { kind: 'condition',
                    if: { kind: 'biome',
                      biomes: ['desert', 'beach', 'snowy_beach', 'river', 'frozen_river', 'ocean', 'deep_ocean', 'warm_ocean', 'frozen_ocean'],
                    },
                    then: { kind: 'block', state: 'sand' },
                  },
                  { kind: 'condition',
                    if: { kind: 'biome', biomes: ['badlands'] },
                    then: { kind: 'sequence',
                      rules: [
                        { kind: 'condition',
                          if: { kind: 'stoneDepth', side: 'floor', offset: 0, addSurfaceDepth: false },
                          then: { kind: 'block', state: 'red_sand' },
                        },
                        { kind: 'bandlands' },
                      ],
                    },
                  },
                  { kind: 'condition',
                    if: { kind: 'biome', biomes: ['stony_shore', 'volcano'] },
                    then: { kind: 'sequence',
                      rules: [
                        { kind: 'condition',
                          if: { kind: 'stoneDepth', side: 'floor', offset: 0, addSurfaceDepth: false },
                          then: { kind: 'condition',
                            if: { kind: 'noiseThreshold', noise: 'surface.noises.patch',
                              min: { param: 'surface.patchThreshold' },
                              max: 8,
                            },
                            then: { kind: 'block', state: 'gravel' },
                          },
                        },
                        { kind: 'block', state: 'stone' },
                      ],
                    },
                  },
                  { kind: 'condition',
                    if: { kind: 'biome', biomes: ['stony_peaks'] },
                    then: { kind: 'sequence',
                      rules: [
                        { kind: 'condition',
                          if: { kind: 'stoneDepth', side: 'floor', offset: 0, addSurfaceDepth: false },
                          then: { kind: 'condition',
                            if: { kind: 'noiseThreshold', noise: 'surface.noises.patch',
                              min: { param: 'surface.patchThreshold' },
                              max: 8,
                            },
                            then: { kind: 'block', state: 'calcite' },
                          },
                        },
                        { kind: 'block', state: 'stone' },
                      ],
                    },
                  },
                  { kind: 'condition',
                    if: { kind: 'biome', biomes: ['frozen_peaks'] },
                    then: { kind: 'sequence',
                      rules: [
                        { kind: 'condition',
                          if: { kind: 'stoneDepth', side: 'floor', offset: 0, addSurfaceDepth: false },
                          then: { kind: 'condition',
                            if: { kind: 'noiseThreshold', noise: 'surface.noises.patch',
                              min: { param: 'surface.patchThreshold' },
                              max: 8,
                            },
                            then: { kind: 'block', state: 'packed_ice' },
                          },
                        },
                        { kind: 'condition',
                          if: { kind: 'stoneDepth', side: 'floor', offset: 0, addSurfaceDepth: false },
                          then: { kind: 'block', state: 'snow_block' },
                        },
                        { kind: 'block', state: 'stone' },
                      ],
                    },
                  },
                  { kind: 'condition',
                    if: { kind: 'biome', biomes: ['snowy_slopes', 'jagged_peaks'] },
                    then: { kind: 'sequence',
                      rules: [
                        { kind: 'condition',
                          if: { kind: 'stoneDepth', side: 'floor', offset: 0, addSurfaceDepth: false },
                          then: { kind: 'block', state: 'snow_block' },
                        },
                        { kind: 'block', state: 'stone' },
                      ],
                    },
                  },
                  { kind: 'condition',
                    if: { kind: 'stoneDepth', side: 'floor', offset: 0, addSurfaceDepth: false },
                    then: { kind: 'sequence',
                      rules: [
                        { kind: 'condition',
                          if: { kind: 'biome', biomes: ['taiga', 'snowy_taiga'] },
                          then: { kind: 'condition',
                            if: { kind: 'noiseThreshold', noise: 'surface.noises.patch',
                              min: { param: 'surface.patchThreshold' },
                              max: 8,
                            },
                            then: { kind: 'block', state: 'podzol' },
                          },
                        },
                        { kind: 'condition',
                          if: { kind: 'biome', biomes: ['taiga', 'snowy_taiga'] },
                          then: { kind: 'condition',
                            if: { kind: 'noiseThreshold', noise: 'surface.noises.patch', min: -8,
                              max: { param: 'surface.patchThreshold', neg: true },
                            },
                            then: { kind: 'block', state: 'coarse_dirt' },
                          },
                        },
                        { kind: 'condition',
                          if: { kind: 'biome', biomes: ['savanna'] },
                          then: { kind: 'condition',
                            if: { kind: 'noiseThreshold', noise: 'surface.noises.patch',
                              min: { param: 'surface.patchThreshold' },
                              max: 8,
                            },
                            then: { kind: 'block', state: 'coarse_dirt' },
                          },
                        },
                        { kind: 'condition',
                          if: { kind: 'biome', biomes: ['jungle'] },
                          then: { kind: 'condition',
                            if: { kind: 'noiseThreshold', noise: 'surface.noises.patch',
                              min: { param: 'surface.patchThreshold' },
                              max: 8,
                            },
                            then: { kind: 'block', state: 'podzol' },
                          },
                        },
                        { kind: 'condition',
                          if: { kind: 'biome', biomes: ['swamp'] },
                          then: { kind: 'condition',
                            if: { kind: 'noiseThreshold', noise: 'surface.noises.patch',
                              min: { param: 'surface.patchThreshold' },
                              max: 8,
                            },
                            then: { kind: 'block', state: 'mud' },
                          },
                        },
                        { kind: 'condition',
                          if: { kind: 'biome', biomes: ['windswept_hills'] },
                          then: { kind: 'condition',
                            if: { kind: 'noiseThreshold', noise: 'surface.noises.patch',
                              min: { param: 'surface.patchThreshold' },
                              max: 8,
                            },
                            then: { kind: 'block', state: 'gravel' },
                          },
                        },
                        { kind: 'condition',
                          if: { kind: 'biome', biomes: ['windswept_hills'] },
                          then: { kind: 'condition',
                            if: { kind: 'noiseThreshold', noise: 'surface.noises.patch', min: -8,
                              max: { param: 'surface.patchThreshold', neg: true },
                            },
                            then: { kind: 'block', state: 'stone' },
                          },
                        },
                        { kind: 'block', state: 'grass_block' },
                      ],
                    },
                  },
                  { kind: 'block', state: 'dirt' },
                ],
              },
            },
            { kind: 'condition',
              if: { kind: 'stoneDepth', side: 'floor', offset: 4, addSurfaceDepth: true },
              then: { kind: 'sequence',
                rules: [
                  { kind: 'condition',
                    if: { kind: 'biome', biomes: ['desert', 'beach', 'snowy_beach'] },
                    then: { kind: 'block', state: 'sandstone' },
                  },
                  { kind: 'condition',
                    if: { kind: 'biome', biomes: ['badlands'] },
                    then: { kind: 'block', state: 'red_sandstone' },
                  },
                ],
              },
            },
          ],
        },
      },
      { kind: 'condition',
        if: { kind: 'verticalGradient', trueAtAndBelow: 0, falseAtAndAbove: 8 },
        then: { kind: 'block', state: 'deepslate' },
      },
    ],
  },
  'surface.rules',
  'surfaceRules',
);
