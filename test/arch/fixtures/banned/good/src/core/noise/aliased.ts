import { helper, type Helper } from '../helper';
import type { Other } from '../other';
const H = helper;
export function f(x: number, o: Other, t: Helper): number { return H(x) + o.helper + t.v; }
export const obj = { helper: 1 };
