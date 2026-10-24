import { afterEach, describe, expect, test, vi } from 'vitest';
import { DEFAULTS } from '../../src/core/params/defaults';
import { createWorkerPool, type WorkerLike } from '../../src/engine/workerPool';
import { COLUMN_SAMPLE_COST, PART_BUDGET } from '../../src/workers/protocol';
import { createTaskHandler } from '../../src/workers/taskHandler';

// Tier 2's column-cost bound keeps every valid tree's per-sample work cost far below PART_BUDGET (about 6.2 M units at
// most under `interpolated`), so the worker's bound (P3) is reached here by a work cost forced to PART_BUDGET.
const HEAVY = vi.hoisted(() => ({ on: false }));
vi.mock('../../src/gen/inspect/cost', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/gen/inspect/cost')>();
  return { ...real, workCost: (...args: Parameters<typeof real.workCost>) => (HEAVY.on ? 8_388_608 : real.workCost(...args)) };
});

afterEach(() => { HEAVY.on = false; });

const configure = { type: 'configure', epoch: 3, seedText: '42', params: DEFAULTS, epochs: null };
const probe = (field: string, path: string) => ({ type: 'fieldProbe', jobId: 5, epoch: 3, scope: 3, field, path, x: -1200, y: 90, z: 8 });
const slice = (field: string, path: string) => ({ type: 'fieldSlice', jobId: 9, epoch: 3, scope: 3, plane: 'vertical', ax: -1664, az: 8, bx: -640, bz: 8, y: 63, n: 32, field, path, from: 0, to: 1 });

describe('the worker refuses a probe or a part above PART_BUDGET (SP3d spec §5.2, §5.3, P3)', () => {
  test('fieldProbe of density or node: BAD_ARGS too heavy when work cost + COLUMN_SAMPLE_COST exceeds PART_BUDGET; rule is never refused', () => {
    const h = createTaskHandler();
    h.handle(configure);
    expect(h.handle(probe('density', '')).msg.type).toBe('fieldProbeResult');
    HEAVY.on = true;
    for (const [field, path] of [['density', ''], ['node', 'root.a']]) {
      expect(h.handle(probe(field!, path!)).msg).toEqual({ type: 'error', jobId: 5, epoch: 3, code: 'BAD_ARGS', message: `too heavy: 1 × ${PART_BUDGET + COLUMN_SAMPLE_COST} work units exceed the part budget ${PART_BUDGET}` });
      expect(h.handle(slice(field!, path!)).msg).toMatchObject({ type: 'error', code: 'BAD_ARGS', message: `too heavy: 1 × ${32 * PART_BUDGET + COLUMN_SAMPLE_COST} work units exceed the part budget ${PART_BUDGET}` });
    }
    expect(h.handle(probe('rule', 'root.rules[2]')).msg.type).toBe('fieldProbeResult');
    expect(h.handle(slice('rule', 'root.rules[2]')).msg.type).toBe('fieldSliceResult');
  });
  test('pool.fieldProbe rejects with the worker\'s BAD_ARGS', async () => {
    const h = createTaskHandler();
    const w: WorkerLike = { onmessage: null, postMessage(m) { setTimeout(() => w.onmessage?.({ data: h.handle(m).msg }), 0); }, terminate() {} };
    const pool = createWorkerPool(1, () => w);
    await pool.configure('42', DEFAULTS);
    HEAVY.on = true;
    await expect(pool.fieldProbe({ field: 'node', path: 'root.a', x: 0, y: 70, z: 0 })).rejects.toThrow(/^BAD_ARGS: too heavy: /);
    pool.terminate();
  });
});
