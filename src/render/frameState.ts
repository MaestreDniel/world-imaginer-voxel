/**
 * What the frame loop hands the materials once per frame (SP4a spec §6.4-§6.7): `setFrameUniforms(frame)` turns it into
 * the shared uniforms and the lightmap. It lives outside `render/materials/` because the page (`ui`) builds it and may
 * not import from there, not even types; the page never constructs a material (`render/renderer.ts` does).
 */
export interface FrameState {
  /** Time of day t ∈ [0, 1), 0 at sunrise (`daynight/dayNight.ts`). */
  readonly t: number;
  /** The lightmap's brightness β ∈ [0, 1] (spec §6.7). */
  readonly brightness: number;
  /** The sky light 0-15 of the camera's voxel: 0 inside terrain, so the fog goes dark there (spec §6.6). */
  readonly eyeSky: number;
  /** Render distance in columns: the fog and the edge fade end at (rd − 0.5)·16. */
  readonly rd: number;
  /** Blocks from the fog's start to its end (`GraphicsPreset.fogBand`). */
  readonly fogBand: number;
  /** The load centre minus the floating origin, (x, z) in blocks: the centre of the edge fade (spec §6.6). */
  readonly edgeCentre: readonly [number, number];
}
