/**
 * The graphics presets (master §4.16) as pure data. SP4a creates the module with the Medium row's fields it reads
 * (SP4a spec §6.10, D17); SP8c adds the audio rows, SP11 the Low, High and Ultra rows and the other fields.
 */

export interface GraphicsPreset {
  /** Render distance in columns. */
  readonly rd: number;
  /** The per-frame upload budget while flying (SP4b; the loading screen uses its own 12 ms). */
  readonly uploadBudgetMs: number;
  /** The most section uploads per frame while flying (SP4b). */
  readonly uploadSections: number;
  readonly ao: boolean;
  readonly smoothLight: boolean;
  /** The water tier: SP4a builds Fast only (master §4.10). */
  readonly water: 'fast';
  /** The pixel ratio is min(devicePixelRatio, pixelRatioCap). */
  readonly pixelRatioCap: number;
  /** Blocks from the fog's start to its end, (RD − 0.5)·16 (SP4a spec §6.6). */
  readonly fogBand: number;
}

/** The Medium row (the iGPU 60 fps target), SP4a's fields only. */
export const MEDIUM: GraphicsPreset = Object.freeze({
  rd: 12,
  uploadBudgetMs: 2,
  uploadSections: 32,
  ao: true,
  smoothLight: true,
  water: 'fast',
  pixelRatioCap: 1,
  fogBand: 64,
});
