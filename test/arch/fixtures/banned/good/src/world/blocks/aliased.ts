import { k, type K } from '../../core/k';
const KF = k;
export const STONE = 1;
export const m = (t: K): number => KF(t) + Math.floor(1.5) + Math.imul(3, 5);
