/**
 * The 1-10 biome-size slider (SP2b spec §6.4). Position v writes `climate.scaleMul = BIOME_SIZE_SCALE[v − 1]`,
 * the q15 of 4^((v − 5)/5). The table is literal so the written value never depends on an engine's Math.pow.
 */
export const BIOME_SIZE_SCALE: readonly number[] = Object.freeze([
  0.329876977693224, 0.435275281648062, 0.574349177498517, 0.757858283255199, 1,
  1.31950791077289, 1.74110112659225, 2.29739670999407, 3.0314331330208, 4,
]);

/**
 * The slider position of a draft's `scaleMul`, nearest in log space:
 * `clamp(Math.round(5 + 2.5 · log2(scaleMul)), 1, 10)` (Math.round takes .5 up, so 2 → 8).
 * `exact` is false when `scaleMul` is not the table value at v: the slider then shows "≈" and the exact
 * value in its tooltip. Total: 0, a negative value or NaN gives 1 and +∞ gives 10, never exact.
 */
export function biomeSizePosition(scaleMul: number): { readonly v: number; readonly exact: boolean } {
  const r = Math.round(5 + 2.5 * Math.log2(scaleMul));
  const v = r >= 10 ? 10 : r >= 1 ? r : 1; // NaN (a negative or NaN scaleMul) fails both tests → 1
  return { v, exact: BIOME_SIZE_SCALE[v - 1] === scaleMul };
}
