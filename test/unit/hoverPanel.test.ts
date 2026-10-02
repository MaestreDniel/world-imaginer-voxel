import { describe, expect, test } from 'vitest';
import { JobCancelled } from '../../src/engine/workerPool';
import { newPointRecord, type ColumnPoint } from '../../src/gen/column/columnPoint';
import { createHoverReadout, formatPoint, OUTSIDE_WINDOW } from '../../src/ui/map/hoverPanel';

const flush = () => new Promise<void>((r) => setImmediate(r));
const pointAt = (x: number, z: number): ColumnPoint => ({ ...newPointRecord(), x, z, biome: 1 });

interface Job { readonly x: number; readonly z: number; resolve(p: ColumnPoint): void; reject(e: Error): void }

/** Point jobs that the test resolves or rejects by hand. */
class FakePool {
  readonly jobs: Job[] = [];
  point(x: number, z: number): Promise<ColumnPoint> {
    return new Promise((resolve, reject) => { this.jobs.push({ x, z, resolve, reject }); });
  }
}

const setup = () => {
  const pool = new FakePool();
  const shown: string[] = [];
  const hover = createHoverReadout(pool, (t) => shown.push(t));
  return { pool, shown, hover };
};

describe('hover readout (SP2b spec §6.3, §2.5)', () => {
  test('a position outside the half-open window [−2^19, 2^19) shows "outside the world window" and sends no job', () => {
    for (const [x, z] of [[524288, 0], [0, 524288], [-524288.5, 0], [0, -524289], [Number.NaN, 0], [0, Infinity]] as const) {
      const { pool, shown, hover } = setup();
      hover.move(x, z);
      expect(pool.jobs).toEqual([]);
      expect(shown).toEqual([OUTSIDE_WINDOW]);
    }
    expect(OUTSIDE_WINDOW).toBe('outside the world window');
  });

  test('the window\'s lower edges are inside and its upper edges outside', async () => {
    const { pool, shown, hover } = setup();
    hover.move(-524288, -524288);
    expect(pool.jobs.map((j) => [j.x, j.z])).toEqual([[-524288, -524288]]);
    pool.jobs[0]!.resolve(pointAt(-524288, -524288));
    await flush();
    hover.move(524287.75, 524287.5);
    expect(pool.jobs.map((j) => [j.x, j.z])).toEqual([[-524288, -524288], [524287.75, 524287.5]]);
    expect(shown).toEqual([formatPoint(pointAt(-524288, -524288))]);
  });

  test('latest wins: one job in flight, then only the newest position', async () => {
    const { pool, shown, hover } = setup();
    hover.move(1, 1);
    hover.move(2, 2);
    hover.move(3, 3);
    expect(pool.jobs).toHaveLength(1);
    pool.jobs[0]!.resolve(pointAt(1, 1));
    await flush();
    expect(pool.jobs.map((j) => [j.x, j.z])).toEqual([[1, 1], [3, 3]]);
    pool.jobs[1]!.resolve(pointAt(3, 3));
    await flush();
    expect(shown).toEqual([formatPoint(pointAt(1, 1)), formatPoint(pointAt(3, 3))]);
    expect(pool.jobs).toHaveLength(2);
  });

  test('a job a configure superseded (JobCancelled) is sent again for the newest position', async () => {
    const { pool, shown, hover } = setup();
    hover.move(5, 6);
    pool.jobs[0]!.reject(new JobCancelled());
    await flush();
    expect(pool.jobs.map((j) => [j.x, j.z])).toEqual([[5, 6], [5, 6]]);
    hover.move(7, 8);
    pool.jobs[1]!.reject(new JobCancelled());
    await flush();
    expect(pool.jobs.map((j) => [j.x, j.z])).toEqual([[5, 6], [5, 6], [7, 8]]);
    pool.jobs[2]!.resolve(pointAt(7, 8));
    await flush();
    expect(shown).toEqual([formatPoint(pointAt(7, 8))]);
  });

  test('a result that lands after the pointer left the window is not shown', async () => {
    const { pool, shown, hover } = setup();
    hover.move(10, 10);
    hover.move(600000, 0);
    pool.jobs[0]!.resolve(pointAt(10, 10));
    await flush();
    expect(shown).toEqual([OUTSIDE_WINDOW]);
    expect(pool.jobs).toHaveLength(1);
  });

  test('refresh re-reads the last position inside the window (a new pool epoch), and nothing once the pointer left', async () => {
    const { pool, shown, hover } = setup();
    hover.refresh();
    expect(pool.jobs).toEqual([]);
    hover.move(4, 4);
    pool.jobs[0]!.resolve(pointAt(4, 4));
    await flush();
    hover.refresh();
    expect(pool.jobs.map((j) => [j.x, j.z])).toEqual([[4, 4], [4, 4]]);
    pool.jobs[1]!.resolve(pointAt(4, 4));
    await flush();
    hover.move(-600000, 0);
    hover.refresh();
    expect(pool.jobs).toHaveLength(2);
    expect(shown).toEqual([formatPoint(pointAt(4, 4)), formatPoint(pointAt(4, 4)), OUTSIDE_WINDOW]);
  });

  test('any other error is shown as text and not retried', async () => {
    const { pool, shown, hover } = setup();
    hover.move(1, 2);
    pool.jobs[0]!.reject(new Error('BAD_MESSAGE: point'));
    await flush();
    expect(shown).toEqual(['Error: BAD_MESSAGE: point']);
    expect(pool.jobs).toHaveLength(1);
  });
});
