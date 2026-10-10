/**
 * The node form's hover value (SP3d spec §3.6, §6 `inspectorHover.test.ts`): `ui/inspector/hoverModel.ts` with a fake
 * pool of deferred `fieldProbe` promises — one probe in flight, the latest wins, a reply dropped when its (epoch, voxel,
 * field, root, path) key is not the current one, JobCancelled at the same epoch asks again, `failed: …`, non-finite
 * values, and `refresh()` after the epoch moved.
 */
import { describe, expect, test } from 'vitest';
import { SLICE_RULE_NA } from '../../src/core/constants';
import { JobCancelled } from '../../src/engine/workerPool';
import {
  createHoverModel, HOVER_WAITING, hoverTarget, hoverValueText, sameHoverKey, type HoverKey, type HoverTarget, type HoverVoxel,
} from '../../src/ui/inspector/hoverModel';
import type { FieldProbeSpec } from '../../src/workers/protocol';

const flush = () => new Promise<void>((done) => { setTimeout(done, 0); });

interface Probe extends FieldProbeSpec {
  readonly priority: number | undefined;
  resolve(v: number): void;
  reject(e: unknown): void;
}

const harness = () => {
  const probes: Probe[] = [];
  const shown: Array<[HoverKey, string]> = [];
  const h = { epoch: 7 as number | null };
  const pool = {
    fieldProbe: (req: FieldProbeSpec, priority?: number) => new Promise<number>((resolve, reject) => {
      probes.push({ ...req, priority, resolve, reject });
    }),
  };
  const model = createHoverModel(pool, () => h.epoch, (key, text) => { shown.push([key, text]); });
  return { model, probes, shown, h };
};

const NODE: HoverTarget = { field: 'node', leaf: 'density.defs', path: 'root.a.a' };
const OTHER: HoverTarget = { field: 'node', leaf: 'density.defs', path: 'root.b' };
const RULE: HoverTarget = { field: 'rule', leaf: 'surface.rules', path: 'root.rules[1]' };
const v = (x: number, y: number, z: number): HoverVoxel => ({ x, y, z });
const key = (t: HoverTarget, p: HoverVoxel, epoch = 7): HoverKey => ({ epoch, ...p, ...t });
const at = (p: Probe) => [p.field, p.path, p.x, p.y, p.z];

describe('the hover target and the value text', () => {
  test('a density selection probes its node (the root included), a rule selection its mask', () => {
    expect(hoverTarget({ leaf: 'density.defs', path: 'root' })).toEqual({ field: 'node', leaf: 'density.defs', path: 'root' });
    expect(hoverTarget({ leaf: 'density.defs', path: 'defs.base.x' })).toEqual({ field: 'node', leaf: 'density.defs', path: 'defs.base.x' });
    expect(hoverTarget({ leaf: 'surface.rules', path: 'root.rules[1].if' })).toEqual({ field: 'rule', leaf: 'surface.rules', path: 'root.rules[1].if' });
  });

  test('values as the slice prints them, non-finite ones included; a rule mask yes / no / n/a', () => {
    expect(hoverValueText('node', 0.5)).toBe('0.5');
    expect(hoverValueText('density', -12)).toBe('-12');
    expect(hoverValueText('node', 1234.5678)).toBe('1235');
    expect(hoverValueText('node', NaN)).toBe('NaN');
    expect(hoverValueText('node', Infinity)).toBe('+∞');
    expect(hoverValueText('density', -Infinity)).toBe('−∞');
    expect([hoverValueText('rule', 1), hoverValueText('rule', 0), hoverValueText('rule', SLICE_RULE_NA)]).toEqual(['yes', 'no', 'n/a']);
  });

  test('keys: every component counts', () => {
    const k = key(NODE, v(1, 2, 3));
    expect(sameHoverKey(k, key(NODE, v(1, 2, 3)))).toBe(true);
    for (const o of [key(NODE, v(1, 2, 3), 8), key(NODE, v(0, 2, 3)), key(NODE, v(1, 0, 3)), key(NODE, v(1, 2, 0)), key(OTHER, v(1, 2, 3)),
      key({ ...NODE, field: 'density' }, v(1, 2, 3)), key({ ...NODE, leaf: 'surface.rules' }, v(1, 2, 3))]) {
      expect(sameHoverKey(k, o)).toBe(false);
    }
  });
});

describe('the probe stream (one in flight, the latest wins)', () => {
  test('a hovered voxel shows … at once and its value when the probe answers; the same key again needs no probe', async () => {
    const t = harness();
    expect(HOVER_WAITING).toBe('…');
    expect(t.model.hover(v(1, 70, 2), NODE)).toBe(HOVER_WAITING);
    expect(t.model.hover(v(1, 70, 2), NODE)).toBe(HOVER_WAITING);
    expect(t.probes.map(at)).toEqual([['node', 'root.a.a', 1, 70, 2]]);
    expect(t.probes[0]!.priority).toBeUndefined();
    t.probes[0]!.resolve(0.25);
    await flush();
    expect(t.shown).toEqual([[key(NODE, v(1, 70, 2)), '0.25']]);
    expect(t.model.hover(v(1, 70, 2), NODE)).toBe('0.25');
    expect(t.probes).toHaveLength(1);
  });

  test('latest wins: one probe in flight; an answer for a key the pointer left is dropped and only the newest key is probed next', async () => {
    const t = harness();
    t.model.hover(v(1, 1, 1), NODE);
    t.model.hover(v(2, 2, 2), NODE);
    t.model.hover(v(3, 3, 3), NODE);
    expect(t.probes.map(at)).toEqual([['node', 'root.a.a', 1, 1, 1]]);
    t.probes[0]!.resolve(1);
    await flush();
    expect(t.shown).toEqual([]);
    expect(t.probes.map(at)).toEqual([['node', 'root.a.a', 1, 1, 1], ['node', 'root.a.a', 3, 3, 3]]);
    t.probes[1]!.resolve(-3);
    await flush();
    expect(t.shown).toEqual([[key(NODE, v(3, 3, 3)), '-3']]);
  });

  test('the same voxel with another node, field or root is another key: the old reply is dropped', async () => {
    const t = harness();
    t.model.hover(v(5, 6, 7), NODE);
    expect(t.model.hover(v(5, 6, 7), OTHER)).toBe(HOVER_WAITING);
    t.probes[0]!.resolve(1);
    await flush();
    expect(t.shown).toEqual([]);
    expect(t.probes.map(at)).toEqual([['node', 'root.a.a', 5, 6, 7], ['node', 'root.b', 5, 6, 7]]);
    t.model.hover(v(5, 6, 7), RULE);
    t.probes[1]!.resolve(2);
    await flush();
    t.probes[2]!.resolve(SLICE_RULE_NA);
    await flush();
    expect(t.shown).toEqual([[key(RULE, v(5, 6, 7)), 'n/a']]);
    // The last answer is remembered for its key: hovering it again sends nothing.
    expect(t.model.hover(v(5, 6, 7), RULE)).toBe('n/a');
    expect(t.probes).toHaveLength(3);
  });

  test('back on the key in flight before it answers: its answer is shown and nothing more is probed', async () => {
    const t = harness();
    t.model.hover(v(1, 1, 1), NODE);
    t.model.hover(v(2, 2, 2), NODE);
    expect(t.model.hover(v(1, 1, 1), NODE)).toBe(HOVER_WAITING);
    t.probes[0]!.resolve(4);
    await flush();
    expect(t.shown).toEqual([[key(NODE, v(1, 1, 1)), '4']]);
    expect(t.probes).toHaveLength(1);
  });

  test('nothing hovered, no selection or no resolved configure: nothing is shown or probed; the answer in flight is dropped', async () => {
    const t = harness();
    expect(t.model.hover(null, NODE)).toBe('');
    expect(t.model.hover(v(1, 1, 1), null)).toBe('');
    t.h.epoch = null;
    expect(t.model.hover(v(1, 1, 1), NODE)).toBe('');
    expect(t.probes).toHaveLength(0);
    t.h.epoch = 7;
    t.model.hover(v(1, 1, 1), NODE);
    t.model.hover(v(2, 2, 2), NODE);
    expect(t.model.hover(null, null)).toBe('');
    t.probes[0]!.resolve(1);
    await flush();
    expect([t.shown, t.probes.length]).toEqual([[], 1]);
  });

  test('an answer that lands after the epoch moved is dropped; refresh() asks again for the voxel still hovered', async () => {
    const t = harness();
    t.model.hover(v(1, 1, 1), NODE);
    t.h.epoch = 8;
    t.probes[0]!.resolve(1);
    await flush();
    expect(t.shown).toEqual([]);
    expect(t.model.refresh()).toBe(HOVER_WAITING);
    expect(t.probes.map(at)).toEqual([['node', 'root.a.a', 1, 1, 1], ['node', 'root.a.a', 1, 1, 1]]);
    t.probes[1]!.resolve(2);
    await flush();
    expect(t.shown).toEqual([[key(NODE, v(1, 1, 1), 8), '2']]);
    expect(t.model.refresh()).toBe('2');
    expect(t.probes).toHaveLength(2);
    // A refresh while a probe of the old epoch is in flight waits for it, then asks at the new epoch.
    t.h.epoch = 9;
    t.model.hover(v(4, 4, 4), NODE);
    t.h.epoch = 10;
    expect(t.model.refresh()).toBe(HOVER_WAITING);
    expect(t.probes).toHaveLength(3);
    t.probes[2]!.resolve(3);
    await flush();
    expect(t.probes.map(at).at(-1)).toEqual(['node', 'root.a.a', 4, 4, 4]);
    expect(t.probes).toHaveLength(4);
    t.probes[3]!.resolve(5);
    await flush();
    expect(t.shown.at(-1)).toEqual([key(NODE, v(4, 4, 4), 10), '5']);
  });

  test('JobCancelled at the same epoch asks again; any other error is shown as `failed: …` and not retried', async () => {
    const t = harness();
    t.model.hover(v(5, 6, 7), NODE);
    t.probes[0]!.reject(new JobCancelled());
    await flush();
    expect([t.shown, t.probes.map(at)]).toEqual([[], [['node', 'root.a.a', 5, 6, 7], ['node', 'root.a.a', 5, 6, 7]]]);
    t.probes[1]!.reject(new Error('BAD_ARGS: path "root.a.a" names no node of density.defs'));
    await flush();
    expect(t.shown).toEqual([[key(NODE, v(5, 6, 7)), 'failed: BAD_ARGS: path "root.a.a" names no node of density.defs']]);
    expect(t.model.hover(v(5, 6, 7), NODE)).toBe('failed: BAD_ARGS: path "root.a.a" names no node of density.defs');
    expect(t.probes).toHaveLength(2);
    // JobCancelled at another epoch is dropped: the hover at the new epoch asks on its own.
    t.model.hover(v(1, 1, 1), NODE);
    t.h.epoch = 8;
    t.probes[2]!.reject(new JobCancelled());
    await flush();
    expect(t.probes).toHaveLength(3);
  });

  test('non-finite values are shown, not refused', async () => {
    const t = harness();
    const shownFor = async (x: number, value: number): Promise<string> => {
      t.model.hover(v(x, 0, 0), NODE);
      t.probes.at(-1)!.resolve(value);
      await flush();
      return t.shown.at(-1)![1];
    };
    expect(await shownFor(1, NaN)).toBe('NaN');
    expect(await shownFor(2, Infinity)).toBe('+∞');
    expect(await shownFor(3, -Infinity)).toBe('−∞');
  });
});
