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
/** rough = (−0.05 − 0.05·Nrm)·(−0.4 + |Nr|). */
const rough = (): JsonValue => mul(add(c(-0.05), mul(c(-0.05), noise('roughnessMod'))), add(c(-0.4), abs(noise('roughness'))));

/**
 * E = tap entrances(interpolated(fl(16·min(Ne·(1/6) + offset + yGrad(−10 → 0.3, 30 → 0), rough + clamp(max(|E1|,
 * |E2|) − threshold, −1, 1))))): no `sky` and no `ramp` (the master's "entrances NOT depth-ramped"). Ne is a unit-sd
 * noise, so its arm is scaled by 1/6 (written `recip(const 6)`, as the cheese roof's 1/24): the default offset 0.37
 * opens where Ne < −2.22 (SP6a spec §1.2).
 */
const entrances = (): JsonValue => tap('entrances', interpolated(fl(mul(c(16), min(
  add(add(mul(noise('entrance'), { op: 'recip', x: c(6) }), param('caves.entrances.offset')), { op: 'slide', x: c(1), knots: [[-10, 0.3], [30, 0]] }),
  add(rough(), clamp(add(max(abs(noise('entranceA')), abs(noise('entranceB'))), neg(param('caves.entrances.threshold'))), -1, 1)),
)))));

/**
 * C = tap cheese(interpolated(sky(fl(16·(layerAmp·L² + clamp(Nch + offset − regional·Nra, −1, 1) + clamp((roofDepth −
 * T)·(1/24), 0, 0.5))) + ramp))): the master's cheese with its roof term; `regional` lowers the threshold where Nra is
 * high (D3).
 */
const cheese = (): JsonValue => tap('cheese', interpolated(sky(add(fl(mul(c(16), add(add(
  mul(param('caves.cheese.layerAmp'), square(noise('layer'))),
  clamp(add(add(noise('cheese'), param('caves.cheese.offset')), neg(mul(param('caves.cheese.regional'), noise2('cheeseRegional')))), -1, 1)),
  clamp(mul(add(param('caves.cheese.roofDepth'), neg(body())), { op: 'recip', x: c(24) }), 0, 0.5),
))), ramp()))));

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

/** The caves slot (SP6a §1.1): max(min(E, C), keep). */
const caves = (): JsonValue => max(min(entrances(), cheese()), keep());

/**
 * The default density expression `{root, defs}` (SP3d spec §2.1; SP3b spec §3.1; SP6a spec §1.1). `defs.body` is the
 * terrain body `defaultDensityExpr` builds under its `interpolated`, with exactly three substitutions in the body and
 * the detail term, `C(1 / clampSigma)` → `recip(param density.noises.jag.clampSigma)`, `C(detailAmpLo)` → `param
 * density.detailAmpLo` and `C(detailAmpHi − detailAmpLo)` → `add(param density.detailAmpHi, neg(param
 * density.detailAmpLo))` (`hi + (−lo)` is `hi − lo` for every pair of doubles, §1.4). The sums stay left-nested in the
 * written order (IEEE addition is not associative). `SLIDE`, the floor and ceiling terms and `islands` = −1e6 are data.
 *
 * The root (SP6a §1.1, D17) is
 * `max(min(min(tap precave(add(tap terrain(interpolated(ref body)), detail)), caves), noodle), tap islands(−1e6))`:
 * `root.a.a.a` is the `precave` tap (the pre-cave density T + detail that the cave tag reads, SP6a §3.2),
 * `root.a.a.a.x.a` the `terrain` tap, `root.a.a.a.x.b` the detail term, `root.a.a.b` the caves slot and `root.a.b`
 * the noodle slot, each `const 1e6` until its term lands, and `root.b` the islands tap. `min(v, 1e6)` is `v` for every
 * value a valid tree reaches, so the values, the bounds decisions and the generated world are SP5c's.
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
        b: { op: 'const', v: 1000000 },
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
