/** The light byte (SP3a spec §2.1, frozen): `sky << 4 | block`, each level 0 … 15. */

export const MAX_LIGHT = 15;

/** Packs sky and block light; each is masked to 4 bits. */
export const packLight = (sky: number, block: number): number => ((sky & 15) << 4) | (block & 15);
export const skyLight = (b: number): number => (b >> 4) & 15;
export const blockLight = (b: number): number => b & 15;
