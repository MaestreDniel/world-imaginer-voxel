/** A hot module (SP4a): imported bindings are read through top-level const aliases only. */
import { k, type K } from '../core/k';
const KF = k;
export const m = (t: K): number => KF(t) + 1;
