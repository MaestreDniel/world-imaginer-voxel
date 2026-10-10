import { describe, expect, test } from 'vitest';
import type { Seed64 } from '../../src/core/hash';
import { createSurfaceReference, ruleNodeAt } from '../../src/gen/surface/reference';
import { conditionThenId, ROOT_RULE_ID, sequenceChildId, type Condition, type Rule } from '../../src/gen/surface/rules';
import { newSurfaceScan, scanColumn } from '../../src/gen/surface/scan';
import { surfaceContextOf } from '../../src/gen/surface/context';
import { ctxFor } from '../harness/gen';
import {
  randomSurfaceColumn, randomSurfaceRules, surfaceFuzzNoiseSource, surfaceFuzzSettings,
} from '../harness/surfaceFuzz';
import { testRng } from '../harness/stats';

/** Every rule and condition of `tree` with its id (SP3c's ids; `.if` into a condition, again into each `not`). */
function nodesOf(tree: Rule): Array<{ id: string; kind: 'rule'; node: Rule } | { id: string; kind: 'condition'; node: Condition }> {
  const out: Array<{ id: string; kind: 'rule'; node: Rule } | { id: string; kind: 'condition'; node: Condition }> = [];
  const walk = (r: Rule, id: string): void => {
    out.push({ id, kind: 'rule', node: r });
    if (r.kind === 'sequence') r.rules.forEach((c, k) => walk(c, sequenceChildId(id, k)));
    if (r.kind === 'condition') {
      let c: Condition = r.if;
      let cid = `${id}.if`;
      for (;;) {
        out.push({ id: cid, kind: 'condition', node: c });
        if (c.kind !== 'not') break;
        c = c.if;
        cid = `${cid}.if`;
      }
      walk(r.then, conditionThenId(id));
    }
  };
  walk(tree, ROOT_RULE_ID);
  return out;
}

describe('ruleNodeAt and SurfaceReference.nodeAt (SP3d spec §4.1)', () => {
  const sc = surfaceContextOf(ctxFor('42'));
  const tree = sc.rules;

  test('every rule and condition of the default tree is found by its id, as the tree\'s own object', () => {
    const nodes = nodesOf(tree);
    expect(nodes.length).toBe(163);
    for (const { id, kind, node } of nodes) {
      const got = sc.reference.nodeAt(id);
      expect(got?.kind, id).toBe(kind);
      expect(got !== undefined && (got.kind === 'rule' ? got.rule : got.condition), id).toBe(node);
    }
    expect(sc.reference.nodeAt('root')).toEqual({ kind: 'rule', rule: tree });
  });

  test('random fuzz trees: every id round-trips, through nested nots too', () => {
    const next = testRng(1717);
    let conditions = 0, nots = 0;
    for (let t = 0; t < 60; t++) {
      const r = randomSurfaceRules(next, { style: (['free', 'fastPath', 'nearMiss'] as const)[t % 3] });
      for (const { id, kind, node } of nodesOf(r)) {
        const got = ruleNodeAt(r, id);
        expect(got !== undefined && (got.kind === 'rule' ? got.rule : got.condition), id).toBe(node);
        expect(got!.kind).toBe(kind);
        if (kind === 'condition') conditions++;
        if (kind === 'condition' && id.endsWith('.if.if')) nots++;
      }
    }
    expect(conditions).toBeGreaterThan(100);
    expect(nots).toBeGreaterThan(0);
  });

  test.each([
    [''], ['roots'], ['rule'], ['root.'], ['root.rules[01]'], ['root.rules[-1]'], ['root.rules[999]'], ['root.rules[1e1]'],
    ['root.then'], ['root.if'], ['root.rules[2].if.falseAtAndAbove'], ['root.rules[2].if.if'], ['root.rules[2].then.then'],
    ['root.rules[2].rules[0]'], ['root.rules[0].if.if.if'], ['root.rules[0]x'], ['constructor'], ['root.rules[0].__proto__'],
  ])('%j names no node', (id) => {
    expect(sc.reference.nodeAt(id)).toBeUndefined();
  });
});

describe('SurfaceReference.conditionHolds (SP3d spec §4.1)', () => {
  test('on fuzz columns it equals a one-condition tree\'s verdict for every condition of fuzz trees', () => {
    const next = testRng(9091);
    const seed: Seed64 = [7, 11];
    const noises = surfaceFuzzNoiseSource(seed);
    const set = surfaceFuzzSettings(seed, undefined, noises);
    let checked = 0, held = 0;
    for (let round = 0; round < 6; round++) {
      const col = randomSurfaceColumn(next);
      const scan = scanColumn(newSurfaceScan(), set, col.sample, col.solid, col.water, col.biomes);
      const tree = randomSurfaceRules(next, { style: (['free', 'fastPath', 'nearMiss'] as const)[round % 3] });
      const ref = createSurfaceReference(seed, tree, noises);
      for (const { id, node } of nodesOf(tree).filter((n) => n.kind === 'condition')) {
        const alone = createSurfaceReference(seed, { kind: 'condition', if: node as Condition, then: { kind: 'block', state: 'stone' } }, noises);
        for (let p = next() % 11; p < 256; p += 11) {
          for (let y = -63; y <= 319; y += 1 + (next() % 9)) {
            if (col.solid[256 * (y + 64) + p] === 0) continue;
            const want = alone.evaluate(scan, set, p, y).path.length > 0;
            expect(ref.conditionHolds(id, scan, set, p, y)).toBe(want);
            checked++;
            if (want) held++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(2000);
    expect(held).toBeGreaterThan(checked / 20);
    expect(held).toBeLessThan(checked);
  });

  test('a rule id, an unknown id or a non-solid voxel is a RangeError', () => {
    const next = testRng(5);
    const seed: Seed64 = [1, 2];
    const noises = surfaceFuzzNoiseSource(seed);
    const set = surfaceFuzzSettings(seed, undefined, noises);
    const col = randomSurfaceColumn(next);
    const scan = scanColumn(newSurfaceScan(), set, col.sample, col.solid, col.water, col.biomes);
    const tree: Rule = { kind: 'sequence', rules: [{ kind: 'condition', if: { kind: 'not', if: { kind: 'skyOpen' } }, then: { kind: 'block', state: 'stone' } }] };
    const ref = createSurfaceReference(seed, tree, noises);
    let p = 0, y = -63;
    while (col.solid[256 * (y + 64) + p] === 0) p++;
    expect(() => ref.conditionHolds('root.rules[0]', scan, set, p, y)).toThrow(RangeError);
    expect(() => ref.conditionHolds('root.rules[1].if', scan, set, p, y)).toThrow(RangeError);
    expect(typeof ref.conditionHolds('root.rules[0].if', scan, set, p, y)).toBe('boolean');
    expect(ref.conditionHolds('root.rules[0].if.if', scan, set, p, y)).toBe(!ref.conditionHolds('root.rules[0].if', scan, set, p, y));
    let ya = 319;
    while (col.solid[256 * (ya + 64) + p] !== 0) ya--;
    expect(() => ref.conditionHolds('root.rules[0].if', scan, set, p, ya)).toThrow(/not solid/);
  });
});
