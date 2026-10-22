/** world/store keeps the ND bans only (SP3a spec §2.5): no Math allowlist, no ** ban, no hot-import rule (padded.ts aside, SP4a). */
import { k } from '../../core/k';
export const len = (a: number, b: number): number => Math.hypot(a, b) + 2 ** 3 + k();
