/**
 * The panorama capture route `?pano=<id>` (SP4a spec §8.3, D22; rulings P48, P54): the world page at the entry's seed,
 * profile and site, RD 12, with no HUD, overlay or start screen, the clock fixed at the entry's hour, the camera 32
 * blocks above `MOTION_BLOCKING` at the entry's yaw and pitch −10°. Three frames after the reveal it sets
 * `window.__wiPano = { ready: true }`, which `test/tools/panoramas.ts` waits for before it captures the screen; a load
 * that fails (or an unknown id) sets `{ ready: false, error }` so the tool stops at once.
 *
 * `PANORAMAS` is a literal copy of the tool's table (the tool runs under plain Node and cannot import `src/`);
 * test/unit/panoramas.test.ts checks that the two are equal and that every site equals its source.
 */
import type { ProfileId } from '../../core/params/profiles';
import { el } from '../common/dom';
import { DEFAULT_MAP_STATE, encodeMapState } from '../map/mapState';
import type { WorldQuery } from './query';
import { mountWorldPage } from './worldPage';

/** One viewpoint (spec §8.3): x and z in blocks (ruling P54), the yaw in degrees (ruling P42), the hour 8 or 17. */
export interface PanoramaSpec {
  readonly id: string;
  readonly seed: string;
  readonly profile: string;
  readonly x: number;
  readonly z: number;
  readonly yawDeg: number;
  readonly time: 8 | 17;
}

/**
 * The six viewpoints, copied from `test/tools/panoramas.ts`: seed 42 default at the coast, mountain and badlands review
 * sites (x = 16·cx0 + 8·w, z = the site's z), and the archipelago, amplified and floating_islands golden window centres.
 */
export const PANORAMAS: readonly PanoramaSpec[] = [
  { id: 'coast', seed: '42', profile: 'default', x: -26624, z: -31992, yawDeg: 135, time: 17 },
  { id: 'mountain', seed: '42', profile: 'default', x: -1152, z: 8, yawDeg: 225, time: 8 },
  { id: 'badlands', seed: '42', profile: 'default', x: -1248, z: 2056, yawDeg: 315, time: 17 },
  { id: 'archipelago', seed: '42', profile: 'archipelago', x: 128, z: -128, yawDeg: 90, time: 17 },
  { id: 'amplified', seed: '42', profile: 'amplified', x: -640, z: 0, yawDeg: 270, time: 8 },
  { id: 'floating_islands', seed: '42', profile: 'floating_islands', x: -768, z: -1408, yawDeg: 90, time: 17 },
];

/** The capture's render distance, eye height above `MOTION_BLOCKING` and pitch (spec §8.3). */
export const PANO_RD = 12;
export const PANO_EYE_ABOVE = 32;
export const PANO_PITCH = -10;
/** Frames rendered after the reveal before the route reports ready (spec §8.3). */
export const PANO_FRAMES = 3;

declare global {
  interface Window {
    /** The capture tool's hook: `ready` three frames after the reveal; `error` when the page cannot get there. */
    __wiPano?: { ready: boolean; error?: string };
  }
}

/** The world page's query for `p`: its site, yaw and pitch, RD 12, the capture mode at its hour (ruling P48). */
export function panoQuery(p: PanoramaSpec): WorldQuery {
  return {
    at: { x: p.x, z: p.z }, y: null, yaw: p.yawDeg, pitch: PANO_PITCH, rd: PANO_RD, workers: null, renderer: null, shot: true, time: p.time,
  };
}

/** The route's `#` hash: `p`'s seed and profile, no patch, the map view centred on the site. */
export function panoHash(p: PanoramaSpec): string {
  return `#${encodeMapState({
    ...DEFAULT_MAP_STATE, seed: p.seed, profile: p.profile as ProfileId, patch: {}, view: { ...DEFAULT_MAP_STATE.view, x: p.x, z: p.z },
  })}`;
}

function failed(root: HTMLElement, error: string): void {
  window.__wiPano = { ready: false, error };
  const panel = el('pre', '', `?pano: ${error}`);
  panel.style.cssText = 'position:fixed;left:8px;top:8px;z-index:10;color:#fff;background:#000c;padding:8px';
  (root.ownerDocument.body ?? root).append(panel);
}

/** Mounts `?pano=<id>` in `root`; an unknown id shows the known ones and reports the error. */
export async function mountPanoramaRoute(root: HTMLElement, id: string): Promise<void> {
  window.__wiPano = { ready: false };
  const p = PANORAMAS.find((e) => e.id === id);
  if (p === undefined) {
    failed(root, `unknown panorama '${id}' (known: ${PANORAMAS.map((e) => e.id).join(', ')})`);
    return;
  }
  const page = await mountWorldPage(root, panoQuery(p), panoHash(p), {
    hud: false,
    overlay: false,
    timeHours: p.time,
    eyeAbove: PANO_EYE_ABOVE,
    onFrame: (n) => {
      if (n >= PANO_FRAMES) window.__wiPano = { ready: true };
    },
  });
  if (page.state !== 'revealed') failed(root, `the world did not load (page ${page.state})`);
}
