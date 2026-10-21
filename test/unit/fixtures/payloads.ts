import { payloadProblem, ROW_INTS, type ColumnMeshPayload } from '../../../src/mesh/column';

/** One row of a fake payload: section sy, pass, and its quad count (4 vertices and 6 indices per quad). */
export interface FakeRow {
  readonly sy: number;
  readonly pass: 0 | 1 | 2;
  readonly quads: number;
}

const QUAD = [0, 1, 2, 0, 2, 3] as const;

/**
 * The bounding sphere of row `r` of a fake payload, in section-local blocks: distinct per row so a test can tell the
 * rows' geometries apart (SP4a spec §5.8's `spheres`).
 */
export function fakeSphere(r: number, row: FakeRow): [number, number, number, number] {
  return [4 + (r % 5), 6 + row.pass, 8 + (row.sy % 4), 9 + (row.quads % 4)];
}

/**
 * A column payload with the given rows, valid under `payloadProblem` (it throws otherwise): each quad is a unit square
 * at a row-dependent spot of the section, every vertex's `data` word is its row number, versions and connectivity are
 * zeros (SP4a spec §5.8).
 */
export function fakePayload(cx: number, cz: number, rows: Array<{ sy: number; pass: 0 | 1 | 2; quads: number }>): ColumnMeshPayload {
  const vertexCount = rows.reduce((n, r) => n + 4 * r.quads, 0);
  const position = new Uint8Array(4 * vertexCount);
  const data = new Uint32Array(vertexCount);
  const index = new Uint32Array(6 * (vertexCount / 4));
  const table = new Int32Array(ROW_INTS * rows.length);
  const spheres = new Float32Array(4 * rows.length);
  let v = 0;
  let i = 0;
  rows.forEach((row, r) => {
    table.set([row.sy, row.pass, v, 4 * row.quads, i, 6 * row.quads], ROW_INTS * r);
    spheres.set(fakeSphere(r, row), 4 * r);
    for (let q = 0; q < row.quads; q++) {
      const x = 8 * ((q + r) % 16);
      const y = 8 * ((q * 3 + row.sy) % 16);
      const corners = [[x, y, 0], [x + 8, y, 0], [x + 8, y + 8, 0], [x, y + 8, 0]] as const;
      for (let k = 0; k < 4; k++) position.set([...corners[k]!, 0], 4 * (v + 4 * q + k));
      for (let k = 0; k < 6; k++) index[i + 6 * q + k] = 4 * q + QUAD[k]!;
    }
    data.fill(r, v, v + 4 * row.quads);
    v += 4 * row.quads;
    i += 6 * row.quads;
  });
  const p: ColumnMeshPayload = {
    cx, cz, versions: new Int32Array(18), connectivity: new Uint16Array(24), position, data, index, rows: table, spheres,
  };
  const problem = payloadProblem(p);
  if (problem !== null) throw new Error(`fakePayload(${cx}, ${cz}): ${problem}`);
  return p;
}
