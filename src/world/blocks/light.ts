/**
 * The light byte (SP3a spec §2.1, frozen): `sky << 4 | block`, each level 0 … 15. The light rule's block side (SP4a
 * spec §4.1, D8; master §2.2): effective opacity and emission over the fluid byte, and the straight sky fall's
 * predicate. Each takes optional tables so partial faces and emitters can be tested before SP8a adds such states.
 */
import { FLUID_LAVA, fluidType } from './fluid';
import { EMIT, FULL_FACES, OPACITY } from './index';
import { FACE_DOWN, FACE_UP } from './kinds';

const OPAQ = OPACITY;
const FULL = FULL_FACES;
const EMITS = EMIT;
const typeOf = fluidType;
const LAVA = FLUID_LAVA;
const UP = FACE_UP;
const DOWN = FACE_DOWN;
const UP_BIT = 1 << UP;
const DOWN_BIT = 1 << DOWN;

export const MAX_LIGHT = 15;

/** Packs sky and block light; each is masked to 4 bits. */
export const packLight = (sky: number, block: number): number => ((sky & 15) << 4) | (block & 15);
export const skyLight = (b: number): number => (b >> 4) & 15;
export const blockLight = (b: number): number => b & 15;

/** The per-state tables the light rule reads (the registry's `OPACITY`, `FULL_FACES` and `EMIT`, or injected ones). */
export interface LightTables {
  readonly opacity: Uint8Array;
  readonly fullFaces: Uint8Array;
  readonly emit: Uint8Array;
}

/** The registry's own tables (never written). */
export const DEFAULT_LIGHT_TABLES: LightTables = { opacity: OPAQ, fullFaces: FULL, emit: EMITS };

/** `max(OPACITY[state], fluidType(fluid) ≠ 0 ? 1 : 0)`: a fluid voxel filters like a 1-opacity block (SP4a spec §4.1). */
export function effOpacity(state: number, fluid: number, t: LightTables = DEFAULT_LIGHT_TABLES): number {
  const o = t.opacity[state]!;
  return o < 1 && typeOf(fluid) !== 0 ? 1 : o;
}

/** `max(EMIT[state], fluidType(fluid) = lava ? 15 : 0)` (SP4a spec §4.1); `EMIT` is at most 15. */
export function effEmit(state: number, fluid: number, t: LightTables = DEFAULT_LIGHT_TABLES): number {
  return typeOf(fluid) === LAVA ? 15 : t.emit[state]!;
}

/**
 * True when the straight sky fall does not enter the voxel (N(y), SP4a spec §4.1): its effective opacity is > 0
 * (water stops the fall), its `FULL_FACES` has the up bit, or the voxel above (`stateAbove`) has the down bit.
 * `LIGHT_BLOCKING` is 1 + the highest such y.
 */
export function fallBlocked(state: number, fluid: number, stateAbove: number, t: LightTables = DEFAULT_LIGHT_TABLES): boolean {
  return effOpacity(state, fluid, t) > 0 || (t.fullFaces[state]! & UP_BIT) !== 0 || (t.fullFaces[stateAbove]! & DOWN_BIT) !== 0;
}
