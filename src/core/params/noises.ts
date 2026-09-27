import type { NoiseDef } from '../noise/types';
import { getPath, type Group, type Schema } from './kit';

export interface NoiseInstance {
  readonly path: string;
  readonly seedName: string;
  readonly def: NoiseDef;
  readonly dims: 2 | 3;
}

/**
 * Every noise instance of a schema, in pre-order (SP1 spec §2.5). The seed name is the leaf's `seedName`
 * or its path; a leaf with components ['x', 'z'] yields `<seedName>.x` and `<seedName>.z`.
 */
export function noiseInstances<R extends Group>(schema: Schema<R>, params: unknown): NoiseInstance[] {
  const out: NoiseInstance[] = [];
  for (const { path, leaf } of schema.leaves) {
    if (leaf.kind !== 'noise') continue;
    const def = getPath(params, path) as NoiseDef;
    const seedName = leaf.seedName ?? path;
    const dims = leaf.dims ?? 2;
    if (leaf.components !== undefined) for (const c of leaf.components) out.push({ path, seedName: `${seedName}.${c}`, def, dims });
    else out.push({ path, seedName, def, dims });
  }
  return out;
}
