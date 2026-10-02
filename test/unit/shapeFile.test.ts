import { describe, expect, test } from 'vitest';
import { canonicalJSON } from '../../src/core/params/canonical';
import { SCHEMA } from '../../src/core/params/schema';
import { normalizeSpline } from '../../src/core/spline/validate';
import { SPLINE_LEAVES, splineOfLeaf } from '../../src/metrics/splineStats';
import { leafOpts } from '../../src/ui/splineEditor/model';
import { readShapeText, SHAPE_FORMAT, shapeFileName, shapeText } from '../../src/ui/splineEditor/shapeFile';
import { paramsWith } from '../harness/gen';

const DEF = paramsWith();
const OFFSET_OPTS = leafOpts('shape.offset');
const doc = (v: unknown) => JSON.stringify(v);
const JAG_SHAPE = { coord: 'C', points: [{ x: -0.5, y: 0, d: 0 }, { x: 0.5, y: 60, d: 12.5 }] };

describe('export', () => {
  test('shapeFileName is <leaf key>.wi10-shape.json', () => {
    expect(SPLINE_LEAVES.map(shapeFileName)).toEqual(['offset.wi10-shape.json', 'sigma.wi10-shape.json', 'jag.wi10-shape.json']);
  });

  test('shapeText writes {format, leaf, spline} as 2-space JSON, newline-terminated', () => {
    const t = shapeText('shape.offset', DEF.shape.offset);
    expect(t.endsWith('}\n')).toBe(true);
    expect(t.startsWith('{\n  "format": "wi10-shape",\n  "leaf": "shape.offset",\n  "spline": {\n')).toBe(true);
    const parsed = JSON.parse(t) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(['format', 'leaf', 'spline']);
    expect(parsed['format']).toBe(SHAPE_FORMAT);
    expect(SHAPE_FORMAT).toBe('wi10-shape');
    expect(canonicalJSON(parsed['spline'])).toBe(canonicalJSON(DEF.shape.offset));
  });

  test('every leaf round-trips: export then import gives the same spline and no notice', () => {
    for (const leaf of SPLINE_LEAVES) {
      const s = splineOfLeaf(DEF, leaf);
      const r = readShapeText(shapeText(leaf, s), leaf, leafOpts(leaf));
      if (!r.ok) throw new Error(r.issues.join('\n'));
      expect(canonicalJSON(r.spline)).toBe(canonicalJSON(s));
      expect(r.notice).toBeNull();
    }
  });
});

describe('import', () => {
  test('a file without leaf (the master\'s original format) imports with no notice', () => {
    const r = readShapeText(doc({ format: 'wi10-shape', spline: JAG_SHAPE }), 'shape.offset', OFFSET_OPTS);
    expect(r).toEqual({ ok: true, spline: JAG_SHAPE, notice: null });
  });

  test('a file for another leaf imports when it validates against the open leaf, with a notice', () => {
    const r = readShapeText(doc({ format: 'wi10-shape', leaf: 'shape.jag', spline: JAG_SHAPE }), 'shape.offset', OFFSET_OPTS);
    expect(r).toEqual({ ok: true, spline: JAG_SHAPE, notice: 'the file\'s shape is for "shape.jag"; imported into shape.offset' });
    const odd = readShapeText(doc({ format: 'wi10-shape', leaf: 'terrain.height', spline: JAG_SHAPE }), 'shape.jag', leafOpts('shape.jag'));
    expect(odd.ok && odd.notice).toBe('the file\'s shape is for "terrain.height"; imported into shape.jag');
  });

  test('validation uses the open leaf\'s range and coords, and lists every issue with its path', () => {
    const r = readShapeText(shapeText('shape.offset', DEF.shape.offset), 'shape.jag', leafOpts('shape.jag'));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.length).toBeGreaterThan(3);
    expect(r.issues.every((i) => /^spline\.points\[\d+\]\.(y\.points\[\d+\]\.)*y: Y_OUT_OF_RANGE — y = [\d.]+ outside \[-16, 128\]$/.test(i))).toBe(true);
    const w = readShapeText(doc({ format: 'wi10-shape', spline: { coord: 'W', points: [{ x: 0, y: 1, d: 0 }, { x: -0.5, y: 2, d: 0 }] } }), 'shape.offset', OFFSET_OPTS);
    expect(w).toEqual({
      ok: false,
      issues: [
        'spline.coord: BAD_COORD — coord must be one of C|E|PV',
        'spline.points[1].x: X_UNSORTED — x = -0.5 is below the previous point (0)',
      ],
    });
  });

  test('the imported spline is normalised (q15, no −0)', () => {
    const raw = { coord: 'E', points: [{ x: -0, y: 0.1 + 0.2, d: -0 }, { x: 1, y: 70, d: 1 / 3 }] };
    const r = readShapeText(doc({ format: 'wi10-shape', spline: raw }).replace('"x":0', '"x":-0'), 'shape.offset', OFFSET_OPTS);
    if (!r.ok) throw new Error(r.issues.join('\n'));
    expect(r.spline).toEqual(normalizeSpline(raw as never));
    expect(Object.is(r.spline.points[0]!.x, 0)).toBe(true);
    expect(r.spline.points[0]!.y).toBe(0.3);
    expect(r.spline.points[1]!.d).toBe(0.333333333333333);
  });

  test('envelope errors: not JSON, not an object, unknown keys, format, leaf type, missing spline', () => {
    const read = (text: string) => readShapeText(text, 'shape.offset', OFFSET_OPTS);
    const notJson = read('{"format": ');
    expect(notJson.ok).toBe(false);
    expect(!notJson.ok && notJson.issues.length === 1 && notJson.issues[0]!.startsWith('file is not JSON: ')).toBe(true);
    for (const v of ['[]', 'null', '3', '"wi10-shape"']) expect(read(v)).toEqual({ ok: false, issues: ['file: NOT_OBJECT — a shape file must be a JSON object'] });
    expect(read(doc({ format: 'wi10-preset', spline: JAG_SHAPE, name: 'x' }))).toEqual({
      ok: false,
      issues: ['name: UNKNOWN_KEY — unknown key "name"', 'format: BAD_FORMAT — format must be "wi10-shape"'],
    });
    expect(read(doc({ spline: JAG_SHAPE }))).toEqual({ ok: false, issues: ['format: BAD_FORMAT — format must be "wi10-shape"'] });
    expect(read(doc({ format: 'wi10-shape', leaf: 42 }))).toEqual({
      ok: false,
      issues: ['leaf: BAD_FORMAT — leaf must be a parameter path such as shape.offset', 'spline: MISSING_KEY — missing'],
    });
    expect(read(doc({ format: 'wi10-shape', leaf: null, spline: JAG_SHAPE }))).toEqual({
      ok: false,
      issues: ['leaf: BAD_FORMAT — leaf must be a parameter path such as shape.offset'],
    });
    expect(read(doc({ format: 'wi10-shape', spline: 'C' }))).toEqual({ ok: false, issues: ['spline: NOT_OBJECT — a spline must be an object {coord, points}'] });
  });

  test('the open leaf\'s options come from the schema, so an import validates exactly as session.set does', () => {
    const meta = SCHEMA.leaves.find((l) => l.path === 'shape.sigma')!.meta;
    const tooHigh = { coord: 'C', points: [{ x: 0, y: meta.max! + 1, d: 0 }] };
    expect(readShapeText(doc({ format: 'wi10-shape', spline: tooHigh }), 'shape.sigma', leafOpts('shape.sigma'))).toEqual({
      ok: false,
      issues: ['spline.points[0].y: Y_OUT_OF_RANGE — y = 65 outside [-16, 64]'],
    });
  });
});
