/**
 * Cross-field lints of the parameter panel (SP2b spec §3.2). They are warnings, not validation: the
 * generator tolerates every inverted pair (a step instead of a fade, no lakes), so the draft stays valid. SP6a spec §4
 * adds the caves pairs (each depth band, each carver range) and two lints of their own (worm length, the island cap, D8).
 */
import { ISLAND_RUN_MIN_BOTTOM } from '../../core/constants';
import { getPath } from '../../core/params/kit';
import { metaOf } from '../../core/params/meta';
import type { Params } from '../../core/params/schema';

export interface ParamLint {
  readonly paths: readonly string[];
  readonly message: string;
}

/** A cave family's depth band past its inversion (SP6a spec §1.4, §4). */
const INVERTED_BAND = 'the range is inverted: the family narrows across it';
/** A carver's drawn range past its inversion (SP6a spec §2.2, §2.3, §4). */
const EMPTY_RANGE = 'the range is empty';

const band = (family: string) => [`caves.${family}.minY`, `caves.${family}.maxY`, INVERTED_BAND] as const;
const range = (group: string, leaf: string) => [`caves.${group}.${leaf}Min`, `caves.${group}.${leaf}Max`, EMPTY_RANGE] as const;

/** Leaf pairs that should satisfy lo < hi, with what the generator does when they do not. */
const ORDERED: ReadonlyArray<readonly [lo: string, hi: string, effect: string]> = [
  ['rivers.coastFadeLo', 'rivers.coastFadeHi', 'valleys switch on as a step instead of fading in from the coast'],
  ['rivers.altFadeLo', 'rivers.altFadeHi', 'channels turn into dry gorges as a step instead of fading'],
  ['lakes.offsetMin', 'lakes.offsetMax', 'lakes (almost) never form'],
  // SP6a spec §4: every depth band of the noise families, then every drawn range of the carvers, in the schema's order.
  band('cheese'), band('spaghetti3d'), band('spaghetti2d'), band('noodles'), band('entrances'),
  range('worms', 'radius'), range('worms', 'vRatio'), range('worms', 'floor'), range('worms', 'roomYScale'), range('worms', 'startY'),
  range('undergroundWorms', 'startY'),
  range('ravines', 'length'), range('ravines', 'startY'),
];

/** floating_islands' cap top: no cave air at y ≥ 180, so no ground run gets its bottom at y ≥ 181 (SP6a spec §1.4, D8). */
const ISLAND_CAP_TOP = ISLAND_RUN_MIN_BOTTOM - 1;

export function paramLints(p: Params): ParamLint[] {
  const out: ParamLint[] = [];
  for (const [lo, hi, effect] of ORDERED) {
    const a = getPath(p, lo) as number;
    const b = getPath(p, hi) as number;
    if (a < b) continue;
    out.push({ paths: [lo, hi], message: `${metaOf(lo)!.label} (${a}) should be below ${metaOf(hi)!.label} (${b}): ${effect}.` });
  }
  // SP6a spec §4: a worm is length − ⌊lengthVar·u⌋ steps long, at least 1 (§2.2).
  const { length, lengthVar } = p.caves.worms;
  if (lengthVar >= length) {
    out.push({
      paths: ['caves.worms.lengthVar', 'caves.worms.length'],
      message: `${metaOf('caves.worms.lengthVar')!.label} (${lengthVar}) should be below ${metaOf('caves.worms.length')!.label} (${length}): some worms are 1 step long.`,
    });
  }
  // SP6a spec §4, D8: the island cap is a leaf, not the islands switch, so the two can disagree.
  const capTop = p.caves.limits.capTop;
  if (p.islands.enabled && capTop > ISLAND_CAP_TOP) {
    out.push({
      paths: ['islands.enabled', 'caves.limits.capTop'],
      message: `Islands are on with ${metaOf('caves.limits.capTop')!.label} (${capTop}) above ${ISLAND_CAP_TOP}: caves may detach runs above y ${ISLAND_CAP_TOP}; the island rules then treat them as islands.`,
    });
  }
  return out;
}
