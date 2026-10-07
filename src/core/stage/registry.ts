import type { RegenScope, StageId } from '../ids';
import type { Group, Schema } from '../params/kit';

export interface StageDef {
  readonly id: StageId;
  readonly version: number;
  /** Upstream stages whose hashes chain into this one; each appears earlier in the list. */
  readonly reads: readonly StageId[];
  /** Param path prefixes this stage reads directly. */
  readonly params: readonly string[];
  readonly checkpoint: 'columnSample' | 'proto' | 'final' | 'none';
}

/** Topological order (SP1 spec §5). SP1 registers every stage; later SPs add prefixes and bump versions (SP2a spec §4.2). */
export const STAGES: readonly StageDef[] = [
  { id: 'climate', version: 1, reads: [], params: ['climate'], checkpoint: 'columnSample' },
  { id: 'shape', version: 2, reads: ['climate'], params: ['shape', 'rivers', 'lakes'], checkpoint: 'columnSample' },
  { id: 'surfaceEst', version: 2, reads: ['shape'], params: [], checkpoint: 'columnSample' },
  { id: 'biome2d', version: 2, reads: ['climate', 'shape', 'surfaceEst'], params: ['biomes'], checkpoint: 'columnSample' },
  { id: 'terrain', version: 1, reads: ['shape', 'surfaceEst', 'biome2d'], params: ['density'], checkpoint: 'proto' },
  { id: 'decorate', version: 1, reads: ['terrain'], params: [], checkpoint: 'final' },
  { id: 'light', version: 1, reads: ['decorate'], params: [], checkpoint: 'none' },
  { id: 'mesh', version: 1, reads: ['light'], params: [], checkpoint: 'none' },
  { id: 'lod', version: 1, reads: ['surfaceEst', 'biome2d'], params: [], checkpoint: 'none' },
  { id: 'map', version: 2, reads: ['climate', 'shape', 'surfaceEst', 'biome2d'], params: [], checkpoint: 'none' },
];

/** Badge scope implied by the first stage that hashes a leaf; null = hosts no params. */
export const SCOPE_OF_STAGE: Readonly<Record<StageId, RegenScope | null>> = {
  climate: 'climate', shape: 'terrain', surfaceEst: 'terrain', biome2d: 'terrain', terrain: 'terrain',
  decorate: 'decorate', light: null, mesh: 'remesh', lod: null, map: null,
};

export function prefixCovers(prefix: string, path: string): boolean {
  return path === prefix || path.startsWith(`${prefix}.`);
}

/** U4 registry invariants (SP1 spec §5); [] = OK. */
export function checkRegistry<R extends Group>(schema: Schema<R>, stages: readonly StageDef[] = STAGES): string[] {
  const out: string[] = [];
  const seen = new Set<StageId>();
  for (const s of stages) {
    if (seen.has(s.id)) out.push(`${s.id}: duplicate stage`);
    for (const r of s.reads) if (!seen.has(r)) out.push(`${s.id}: reads ${r}, which is not declared earlier`);
    if (!Number.isInteger(s.version) || s.version < 1) out.push(`${s.id}: version must be an integer ≥ 1`);
    for (const p of s.params) if (!schema.byPath.has(p)) out.push(`${s.id}: prefix "${p}" matches no schema node`);
    if (SCOPE_OF_STAGE[s.id] === null && s.params.length > 0) out.push(`${s.id}: hosts params, but light, lod and map host none`);
    seen.add(s.id);
  }
  for (const { path, meta } of schema.leaves) {
    const covering = stages.filter((s) => s.params.some((p) => prefixCovers(p, path)));
    if (meta.scope === 'live') {
      if (covering.length > 0) out.push(`${path}: live leaf is hashed by ${covering.map((s) => s.id).join(', ')}`);
      continue;
    }
    if (meta.stage === undefined) { out.push(`${path}: non-live leaf without a stage`); continue; }
    if (!covering.some((s) => s.id === meta.stage)) out.push(`${path}: home stage ${meta.stage} does not hash it`);
    const first = covering[0];
    if (first === undefined) { out.push(`${path}: hashed by no stage`); continue; }
    const implied = SCOPE_OF_STAGE[first.id];
    if (implied !== meta.scope) out.push(`${path}: scope ${meta.scope} but first hashed by ${first.id} (scope ${implied ?? 'none'})`);
  }
  return out;
}
