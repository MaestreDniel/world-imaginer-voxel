/**
 * The first world stage a configure dirties (SP4c spec §4.1, D8). The workers' ready reply carries the stage hashes and
 * the genKey as hex strings (`workers/protocol.ts` `ReadyMsg`), so an applied draft keeps them in hex and `regenFrom`
 * compares hex per stage, in `STAGES` order. Pure; allocates nothing beyond its result.
 */
import type { StageId } from '../core/ids';
import { STAGES } from '../core/stage/registry';

/** The world's four column stages (`rings.ts`'s `Stage`): terrain, the D skeleton, the exact light and the mesh. */
export type WorldStage = 'T' | 'D' | 'L' | 'MESH';

/** A draft the world applied: its seed key, its stage hashes and its genKey, all as the workers report them (hex). */
export interface AppliedDraft {
  readonly seedKey: string;
  readonly hashes: Readonly<Partial<Record<StageId, string>>>;
  readonly genKey: string;
}

/** Each stage's world stage; null for the stages no world column reads (lod, map). */
const WORLD_STAGE_OF: Readonly<Record<StageId, WorldStage | null>> = Object.freeze({
  climate: 'T', shape: 'T', surfaceEst: 'T', biome2d: 'T', terrain: 'T',
  decorate: 'D', light: 'L', mesh: 'MESH', lod: null, map: null,
});

/**
 * A different seed key → 'T'; else the world stage of the first stage of `STAGES` whose hex differs or is missing on
 * either side (climate, shape, surfaceEst, biome2d, terrain → 'T'; decorate → 'D'; light → 'L'; mesh → 'MESH'); lod or
 * map only, or nothing → null.
 */
export function regenFrom(prev: AppliedDraft, next: AppliedDraft): WorldStage | null {
  if (prev.seedKey !== next.seedKey) return 'T';
  for (let i = 0; i < STAGES.length; i++) {
    const id = STAGES[i]!.id;
    const w = WORLD_STAGE_OF[id];
    if (w === null) continue;
    const a = prev.hashes[id];
    const b = next.hashes[id];
    if (a === undefined || b === undefined || a !== b) return w;
  }
  return null;
}

/** The applied draft of a resolved configure: the session's seed key with the ready reply's hex hashes and genKey. */
export function appliedDraftOf(
  seedKey: string,
  ready: { readonly stageHashes: Readonly<Partial<Record<StageId, string>>>; readonly genKey: string },
): AppliedDraft {
  return { seedKey, hashes: ready.stageHashes, genKey: ready.genKey };
}
