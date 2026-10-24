/**
 * What the frame loop hands the materials once per frame (SP4a spec §6.4-§6.7): `setFrameUniforms(frame)` turns it into
 * the shared uniforms and the lightmap; the page reuses one object across frames (SP4b spec §3.10). It lives outside
 * `render/materials/` because the page (`ui`) builds it and may not import from there, not even types; the page never
 * constructs a material (`render/renderer.ts` does).
 */
export interface FrameState {
  /** Time of day t ∈ [0, 1), 0 at sunrise (`daynight/dayNight.ts`). */
  readonly t: number;
  /** The lightmap's brightness β ∈ [0, 1] (spec §6.7). */
  readonly brightness: number;
  /** The sky light 0-15 of the camera's voxel: 0 inside terrain, so the fog goes dark there (spec §6.6). */
  readonly eyeSky: number;
  /** The fog's render distance, fractional while a raise eases (spec §5): the fog ends at (rd − 1)·16 (spec §6.3). */
  readonly rd: number;
  /** Blocks from the fog's start to its end (`GraphicsPreset.fogBand`). */
  readonly fogBand: number;
}
