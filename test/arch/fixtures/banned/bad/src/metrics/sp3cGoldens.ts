export const stamp = (): number => Date.now();
export const angle = (z: number, x: number): number => Math.atan2(z, x);
export const sort = (a: string, b: string): number => a.localeCompare(b);
export const square = (v: number): number => v ** 2;
