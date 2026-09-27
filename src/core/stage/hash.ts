import { GENERATOR_VERSION } from '../constants';
import { fnv1a64, hex64, type Hash64, type Seed64 } from '../hash';
import type { StageId } from '../ids';
import { canonicalJSON } from '../params/canonical';
import { getPath } from '../params/kit';
import { STAGES, type StageDef } from './registry';

export type StageHashes = Readonly<Partial<Record<StageId, Hash64>>>;

/**
 * H[S] = fnv1a64(`${id}|${version}|${canonicalJSON(slice)}|${reads.map(hex64(H[r])).join(',')}`) with
 * slice = {prefix: subtree} over S.params (SP1 spec §5). Seed-independent.
 */
export function stageHashes(params: unknown, stages: readonly StageDef[] = STAGES): StageHashes {
  const h: Partial<Record<StageId, Hash64>> = {};
  for (const s of stages) {
    const slice: Record<string, unknown> = {};
    for (const p of s.params) slice[p] = getPath(params, p);
    const up = s.reads.map((r) => {
      const x = h[r];
      if (x === undefined) throw new Error(`${s.id} reads ${r} before it is hashed`);
      return hex64(x);
    }).join(',');
    h[s.id] = fnv1a64(`${s.id}|${s.version}|${canonicalJSON(slice)}|${up}`);
  }
  return h;
}

/** fnv1a64(`${GENERATOR_VERSION}|${lo}|${hi}|${hex64(H.decorate)}`), seed words as decimal u32. */
export function genKey(seed: Seed64, hashes: StageHashes): Hash64 {
  const d = hashes.decorate;
  if (d === undefined) throw new Error('genKey needs the decorate stage hash');
  return fnv1a64(`${GENERATOR_VERSION}|${seed[0]}|${seed[1]}|${hex64(d)}`);
}

/** Stages whose hash differs, in stage-list order. */
export function dirtyStages(a: StageHashes, b: StageHashes, stages: readonly StageDef[] = STAGES): StageId[] {
  return stages.filter((s) => {
    const x = a[s.id];
    const y = b[s.id];
    return x === undefined || y === undefined || hex64(x) !== hex64(y);
  }).map((s) => s.id);
}

export function paramsHash(params: unknown): Hash64 {
  return fnv1a64(canonicalJSON(params));
}
