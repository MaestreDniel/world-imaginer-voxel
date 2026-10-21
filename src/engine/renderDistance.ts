/**
 * The 3D page's render distance (SP4a spec §8.5, D23, ruling P36): the default from the capability report, the cap the
 * accepted store reservation sets, and the one resolution of `?rd`, the setting and the default under that cap.
 */
import type { CapabilityReport, StoreReservation } from './capabilityRules';

/** The render distance's range in columns (the `?rd` and settings clamps). */
export const RD_MIN = 4;
export const RD_MAX = 16;

const MIB = 1 << 20;

/** Whether the renderer string names a software rasteriser. Firefox masks the string, so this only fires when it names one. */
export function isSoftwareRenderer(renderer: string): boolean {
  return /SwiftShader|llvmpipe|softpipe|Software/i.test(renderer);
}

/**
 * The render distance the accepted reservation allows: 16 at the full (768, 512) MiB, 8 at (384, 256) MiB, 6 below
 * (and for null, which the world rules block anyway).
 */
export function reservationRdCap(res: StoreReservation | null): number {
  if (res === null) return 6;
  if (res.blockBytes >= 768 * MIB) return RD_MAX;
  if (res.blockBytes >= 384 * MIB) return 8;
  return 6;
}

/**
 * The default render distance: 6 on a software renderer; else 8 with ≤ 4 cores or ≤ 4 GB of `deviceMemory` (absent in
 * Firefox: unknown, not weak); else 12. Capped by the reservation (`reservationRdCap`).
 */
export function defaultRenderDistance(r: CapabilityReport): number {
  const weak = (r.hardwareConcurrency !== null && r.hardwareConcurrency <= 4) || (r.deviceMemory !== null && r.deviceMemory <= 4);
  const rule = r.renderer !== null && isSoftwareRenderer(r.renderer) ? 6 : weak ? 8 : 12;
  return Math.min(rule, reservationRdCap(r.reservation));
}

/** An integer render distance in [RD_MIN, min(RD_MAX, cap)] (never below RD_MIN; NaN reads as RD_MIN). */
export function clampRenderDistance(rd: number, cap: number): number {
  const hi = Math.max(RD_MIN, Math.min(RD_MAX, Math.floor(cap)));
  if (Number.isNaN(rd)) return RD_MIN;
  return Math.min(hi, Math.max(RD_MIN, Math.round(rd)));
}

/**
 * The session's one render distance (ruling P36): `?rd`, else the setting, else the default, clamped under the
 * reservation's cap. Everything that needs rd reads this value.
 */
export function resolveRenderDistance(r: CapabilityReport, queryRd: number | null, settingsRd: number | null): number {
  return clampRenderDistance(queryRd ?? settingsRd ?? defaultRenderDistance(r), reservationRdCap(r.reservation));
}
