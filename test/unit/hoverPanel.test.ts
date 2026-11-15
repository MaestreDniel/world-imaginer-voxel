import { describe, expect, test } from 'vitest';
import { JobCancelled } from '../../src/engine/workerPool';
import { newPointRecord, type ColumnPoint } from '../../src/gen/column/columnPoint';
import type { PointReply } from '../../src/engine/workerPool';
import { caveBiomeLine, createHoverReadout, formatPoint, OUTSIDE_WINDOW } from '../../src/ui/map/hoverPanel';
import type { MapView } from '../../src/ui/map/mapState';

const flush = () => new Promise<void>((r) => setImmediate(r));
const pointAt = (x: number, z: number): ColumnPoint => ({ ...newPointRecord(), x, z, biome: 1 });

interface Job { readonly x: number; readonly z: number; readonly args: readonly unknown[]; resolve(p: PointReply): void; reject(e: Error): void }

/** Point jobs that the test resolves or rejects by hand. */
class FakePool {
  readonly jobs: Job[] = [];
  point(x: number, z: number, ...rest: unknown[]): Promise<PointReply> {
    return new Promise((resolve, reject) => { this.jobs.push({ x, z, args: [x, z, ...rest], resolve, reject }); });
  }
}

const setup = (view: Pick<MapView, 'layer' | 'caveY'> = { layer: 'biome' }) => {
  const pool = new FakePool();
  const shown: string[] = [];
  const at = { view };
  const hover = createHoverReadout(pool, (t) => shown.push(t), () => at.view);
  return { pool, shown, hover, at };
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

  test('dispose: a job that resolves or is cancelled later shows nothing and sends nothing; later moves send nothing (SP4c spec §1.2)', async () => {
    const { pool, shown, hover } = setup();
    hover.move(1, 2);
    hover.move(3, 4);
    hover.dispose();
    pool.jobs[0]!.reject(new JobCancelled());
    await flush();
    hover.move(5, 6);
    hover.refresh();
    expect(pool.jobs).toHaveLength(1);
    pool.jobs[0]!.resolve(pointAt(1, 2));
    await flush();
    expect(shown).toEqual([]);
  });
});

describe('the hover\'s cave-biome line (SP6b spec §9.1, Spec correction 24)', () => {
  const lush: PointReply = { ...pointAt(3, 4), caveBiome: { id: 1, depth: 0.4249 } };

  test('the line\'s text from a point reply with caveBiome lush: "cave biome at y n: lush (depth 0.42)"; above the ground (id 255) "none (above the ground)"', () => {
    expect(caveBiomeLine(-12, { id: 1, depth: 0.4249 })).toBe('cave biome at y -12: lush (depth 0.42)');
    expect(caveBiomeLine(40, { id: 0, depth: 0.05 })).toBe('cave biome at y 40: plain (depth 0.05)');
    expect(caveBiomeLine(-50, { id: 3, depth: 1.2 })).toBe('cave biome at y -50: abyss (depth 1.20)');
    expect(caveBiomeLine(200, { id: 255, depth: -0.9 })).toBe('cave biome at y 200: none (above the ground)');
    expect(formatPoint(lush, -12)).toBe(`${formatPoint(pointAt(3, 4))}\ncave biome at y -12: lush (depth 0.42)`);
    // No y (another layer), or a reply without the field: no line.
    expect([formatPoint(lush), formatPoint(pointAt(3, 4), -12)]).toEqual([formatPoint(pointAt(3, 4)), formatPoint(pointAt(3, 4))]);
  });

  test('with the caveBiome layer selected the pool\'s point receives the map\'s caveY (0 when the view has none) and the line shows', async () => {
    const { pool, shown, hover, at } = setup({ layer: 'caveBiome', caveY: -12 });
    hover.move(3, 4);
    expect(pool.jobs[0]!.args).toEqual([3, 4, undefined, -12]);
    pool.jobs[0]!.resolve(lush);
    await flush();
    expect(shown).toEqual([`${formatPoint(pointAt(3, 4))}\ncave biome at y -12: lush (depth 0.42)`]);
    at.view = { layer: 'caveBiome' };
    hover.refresh();
    expect(pool.jobs[1]!.args).toEqual([3, 4, undefined, 0]);
  });

  test('with another layer no y is sent and no line shows', async () => {
    const { pool, shown, hover } = setup({ layer: 'biome', caveY: -12 });
    hover.move(3, 4);
    expect(pool.jobs[0]!.args[3]).toBeUndefined();
    pool.jobs[0]!.resolve(pointAt(3, 4));
    await flush();
    expect(shown).toEqual([formatPoint(pointAt(3, 4))]);
    expect(shown[0]).not.toContain('cave biome');
  });
});
