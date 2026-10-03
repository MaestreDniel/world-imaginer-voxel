export const stamp = (): number => performance.now();
export const length = (dx: number, dz: number): number => Math.hypot(dx, dz);
export const cube = (v: number): number => v ** 3;
