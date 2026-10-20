import { expect, test } from 'vitest';
import {
  MESH_PASS_CUTOUT,
  MESH_PASS_OPAQUE,
  MESH_PASS_TRANSLUCENT,
  payloadProblem,
  ROW_INTS,
  type ColumnMeshPayload,
} from '../../src/mesh/column';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * Two rows: sy 4 opaque with 2 quads (8 vertices, 12 indices), then sy 5 translucent with 1 quad (4 vertices,
 * 6 indices). Indices are relative to the row's first vertex.
 */
function valid(): Mutable<ColumnMeshPayload> {
  const quad = [0, 1, 2, 0, 2, 3];
  return {
    cx: 3,
    cz: -2,
    versions: new Int32Array(18),
    connectivity: new Uint16Array(24),
    position: new Uint8Array(4 * 12),
    data: new Uint32Array(12),
    index: new Uint32Array([...quad, ...quad.map((i) => i + 4), ...quad]),
    rows: new Int32Array([4, MESH_PASS_OPAQUE, 0, 8, 0, 12, 5, MESH_PASS_TRANSLUCENT, 8, 4, 12, 6]),
    spheres: new Float32Array([8, 8, 8, 13.9, 8, 15, 8, 11.4]),
  };
}

test('the pass ids and the row width (SP4a spec §5.8)', () => {
  expect([MESH_PASS_OPAQUE, MESH_PASS_CUTOUT, MESH_PASS_TRANSLUCENT]).toEqual([0, 1, 2]);
  expect(ROW_INTS).toBe(6);
});

test('null on a valid two-row payload', () => {
  expect(payloadProblem(valid())).toBeNull();
});

test('null on an empty payload', () => {
  const p = valid();
  p.position = new Uint8Array(0);
  p.data = new Uint32Array(0);
  p.index = new Uint32Array(0);
  p.rows = new Int32Array(0);
  p.spheres = new Float32Array(0);
  expect(payloadProblem(p)).toBeNull();
});

/** Each case breaks one rule of a valid payload; the message names what is wrong. */
const BROKEN: Array<[string, (p: Mutable<ColumnMeshPayload>) => void, RegExp]> = [
  ['rows.length % 6 ≠ 0', (p) => { p.rows = p.rows.slice(0, 11); }, /rows/],
  ['spheres.length ≠ 4·rows', (p) => { p.spheres = p.spheres.slice(0, 4); }, /spheres/],
  ['a vertex range past data.length', (p) => { p.data = p.data.slice(0, 11); }, /vertex/],
  ['a vertex range past position.length / 4', (p) => { p.position = p.position.slice(0, 44); }, /vertex/],
  ['a negative vertexStart', (p) => { p.rows[2] = -1; }, /vertex/],
  ['an index range past index.length', (p) => { p.index = p.index.slice(0, 17); }, /index range/],
  ['an index ≥ its row\'s vertexCount', (p) => { p.index[13] = 4; }, /index 4/],
  ['sy outside 0-23 (24)', (p) => { p.rows[ROW_INTS] = 24; }, /sy 24/],
  ['sy outside 0-23 (−1)', (p) => { p.rows[0] = -1; }, /sy -1/],
  ['pass outside 0-2 (3)', (p) => { p.rows[1] = 3; }, /pass 3/],
  ['pass outside 0-2 (−1)', (p) => { p.rows[ROW_INTS + 1] = -1; }, /pass -1/],
  ['versions.length ≠ 18', (p) => { p.versions = new Int32Array(17); }, /versions/],
  ['connectivity.length ≠ 24', (p) => { p.connectivity = new Uint16Array(25); }, /connectivity/],
];

test.each(BROKEN)('a message for %s', (_name, breakIt, message) => {
  const p = valid();
  breakIt(p);
  const problem = payloadProblem(p);
  expect(problem).not.toBeNull();
  expect(problem).toMatch(message);
});
