/**
 * The raycast visibility reference of R3 (SP6b spec §12.4, D22; master §6.1): `raycastVisible` in
 * `test/harness/refs.ts`, 3D DDA rays in 6 × faceRes² cube-map directions from the eye, each stopping at the first
 * opaque full cube, reporting every section it enters (the stopping one included).
 */
import { describe, expect, test } from 'vitest';
import { raycastVisible } from '../harness/refs';

const FACE_RES = 128;
const key = (cx: number, sy: number, cz: number): string => `${cx},${sy},${cz}`;

/** The sections `raycastVisible` reports from `eye`. */
function seen(opaqueAt: (x: number, y: number, z: number) => boolean, eye: readonly [number, number, number], maxDist: number): Set<string> {
  const out = new Set<string>();
  raycastVisible(opaqueAt, eye, maxDist, FACE_RES, (cx, sy, cz) => out.add(key(cx, sy, cz)));
  return out;
}

/** The squared distance from `eye` to the nearest and the farthest point of section (cx, sy, cz). */
function sectionDist2(eye: readonly [number, number, number], cx: number, sy: number, cz: number): { near: number; far: number } {
  const lo = [16 * cx, 16 * sy - 64, 16 * cz];
  let near = 0;
  let far = 0;
  for (let a = 0; a < 3; a++) {
    const e = eye[a]!;
    const l = lo[a]!;
    const h = l + 16;
    const d = e < l ? l - e : e > h ? e - h : 0;
    near += d * d;
    const f = Math.max(Math.abs(e - l), Math.abs(e - h));
    far += f * f;
  }
  return { near, far };
}

describe('raycastVisible (SP6b spec §12.4)', () => {
  test('in an empty grid every section within maxDist is seen, and none beyond it', () => {
    const eye = [8.5, 72.5, 8.5] as const;
    const maxDist = 40;
    const s = seen(() => false, eye, maxDist);
    let inside = 0;
    for (let cx = -4; cx <= 4; cx++) {
      for (let sy = 4; sy <= 13; sy++) {
        for (let cz = -4; cz <= 4; cz++) {
          const { near, far } = sectionDist2(eye, cx, sy, cz);
          if (far <= maxDist * maxDist) {
            inside++;
            expect(s.has(key(cx, sy, cz)), `section (${cx}, ${sy}, ${cz}) lies within maxDist`).toBe(true);
          }
          if (near > maxDist * maxDist) expect(s.has(key(cx, sy, cz)), `section (${cx}, ${sy}, ${cz}) lies beyond maxDist`).toBe(false);
        }
      }
    }
    expect(inside).toBeGreaterThan(10);
  });

  test('behind a solid wall no section is seen', () => {
    // A wall filling x 20 … 23 (inside section cx 1) at every y and z.
    const eye = [8.5, 72.5, 8.5] as const;
    const s = seen((x) => x >= 20 && x < 24, eye, 200);
    expect([...s].filter((k) => Number(k.split(',')[0]) >= 2), 'sections beyond the wall').toEqual([]);
    // The wall's own section is entered (the stopping one included), and those before it.
    expect(s.has(key(1, 8, 0))).toBe(true);
    expect(s.has(key(0, 8, 0))).toBe(true);
  });

  test('through a 1-voxel hole the section beyond is seen from 1 section away', () => {
    // A wall at x 31 (the last voxel layer of section cx 1) with one hole at (31, 75, 7); the eye in section cx 0.
    const eye = [8.5, 75.5, 7.5] as const;
    const hole = (x: number, y: number, z: number): boolean => x === 31 && y === 75 && z === 7;
    const holed = seen((x, y, z) => x === 31 && !hole(x, y, z), eye, 200);
    expect(holed.has(key(2, 8, 0)), 'the section beyond the hole').toBe(true);
    const sealed = seen((x) => x === 31, eye, 200);
    expect([...sealed].filter((k) => Number(k.split(',')[0]) >= 2), 'sections beyond the wall without the hole').toEqual([]);
  });

  test('an eye inside an opaque voxel sees only its own section', () => {
    const s = seen(() => true, [8.5, 72.5, 8.5], 100);
    expect([...s]).toEqual([key(0, 8, 0)]);
  });

  test('nothing above y 319 or below y −64 is reported; an eye above the world sees into it', () => {
    const above = seen(() => false, [8.5, 330, 8.5], 40);
    expect(above.size).toBeGreaterThan(0);
    for (const k of above) {
      const sy = Number(k.split(',')[1]);
      expect(sy >= 0 && sy <= 23, `section y ${sy}`).toBe(true);
    }
    expect(above.has(key(0, 23, 0))).toBe(true);
    // With nothing opaque, rays leaving the world below y −64 report no section there.
    const low = seen(() => false, [8.5, -60.5, 8.5], 40);
    expect(low.has(key(0, 0, 0))).toBe(true);
    for (const k of low) expect(Number(k.split(',')[1])).toBeGreaterThanOrEqual(0);
  });

  test('faceRes must be a positive integer', () => {
    expect(() => raycastVisible(() => false, [0, 0, 0], 10, 0, () => undefined)).toThrow(RangeError);
    expect(() => raycastVisible(() => false, [0, 0, 0], 10, 1.5, () => undefined)).toThrow(RangeError);
  });
});
