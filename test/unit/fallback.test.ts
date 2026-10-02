import { describe, expect, test } from 'vitest';
import type { MapLevel } from '../../src/core/constants';
import { resolveProfile } from '../../src/core/params/profiles';
import type { Params } from '../../src/core/params/schema';
import type { Spawn } from '../../src/gen/column/spawn';
import { createFallbacks, type Fallbacks, type Frame, type LevelTiles, type TilePos } from '../../src/ui/map/fallback';
import type { MapCanvas } from '../../src/ui/map/mapView';
import { createPreviewDriver, type DriverCanvas, type DriverClock, type DriverDraft, type DriverPool, type PreviewDriver } from '../../src/ui/map/previewDriver';
import { createTileCache } from '../../src/ui/map/tileCache';
import { createTileSource } from '../../src/ui/map/tileSource';
import { visibleTiles } from '../../src/ui/map/viewMath';

const PARAMS: Params = resolveProfile('default');
const flush = () => new Promise<void>((r) => setImmediate(r));

/** A key per source and position, like tileKey's (layer, level, tx, tz, hash). */
const keyOf = (src: string) => (level: MapLevel, tx: number, tz: number): string => `${src}|${level}|${tx}|${tz}`;
const NO_SOURCE = (): string | null => null;
const P = (tx: number, tz: number): TilePos => ({ tx, tz });
const previews = (tiles: readonly TilePos[]): LevelTiles[] => [{ level: 256, tiles }];
/** The tile drawn at each position of a frame, as 'key' or 'key (fallback)'. */
const drawn = (f: Frame<string>) => f.draws.map((d) => `${d.key}${d.fallback ? ' (fallback)' : ''}`);

describe('fallback tiles (SP2b spec §2.5)', () => {
  test('the current source where it has a cached tile, else the key last drawn at that position while it is still cached', () => {
    const fb = createFallbacks();
    const cache = createTileCache<string>(64, (_v, key) => fb.evicted(key));
    const get = (k: string) => cache.get(k);
    const at = [P(0, 0), P(1, 0)];
    cache.set('s1|256|0|0', 'A1');
    cache.set('s1|256|1|0', 'B1');
    expect(drawn(fb.frame('biome', previews(at), keyOf('s1'), get))).toEqual(['s1|256|0|0', 's1|256|1|0']);
    expect(fb.keyAt('biome', 256, 1, 0)).toBe('s1|256|1|0');
    // A reconfigure: no key until the next source is set, then no tile yet. The old tiles stay on screen.
    expect(drawn(fb.frame('biome', previews(at), NO_SOURCE, get))).toEqual(['s1|256|0|0 (fallback)', 's1|256|1|0 (fallback)']);
    expect(drawn(fb.frame('biome', previews(at), keyOf('s2'), get))).toEqual(['s1|256|0|0 (fallback)', 's1|256|1|0 (fallback)']);
    // A tile of the newer source lands at (0, 0): drawn, and it is that position's fallback from now on.
    cache.set('s2|256|0|0', 'A2');
    const f = fb.frame('biome', previews(at), keyOf('s2'), get);
    expect(drawn(f)).toEqual(['s1|256|1|0 (fallback)', 's2|256|0|0']);
    expect(f.draws.map((d) => d.tile)).toEqual(['B1', 'A2']);
    expect(drawn(fb.frame('biome', previews(at), keyOf('s3'), get))).toEqual(['s2|256|0|0 (fallback)', 's1|256|1|0 (fallback)']);
    expect([fb.keyAt('biome', 256, 0, 0), fb.keyAt('biome', 256, 1, 0), fb.size]).toEqual(['s2|256|0|0', 's1|256|1|0', 2]);
  });

  test('a fallback changes only when a current tile is drawn there: not by a source change, a missing tile or a tile cached under another key', () => {
    const fb = createFallbacks();
    const cache = createTileCache<string>(64, (_v, key) => fb.evicted(key));
    const get = (k: string) => cache.get(k);
    const at = [P(0, 0)];
    cache.set('s1|256|0|0', 'A1');
    fb.frame('biome', previews(at), keyOf('s1'), get);
    // s2 was superseded by s3 before it drew anything; its late tile is cached but never drawn.
    cache.set('s2|256|0|0', 'A2');
    for (let i = 0; i < 5; i++) expect(drawn(fb.frame('biome', previews(at), keyOf('s3'), get))).toEqual(['s1|256|0|0 (fallback)']);
    expect(fb.keyAt('biome', 256, 0, 0)).toBe('s1|256|0|0');
  });

  test('a fallback whose tile left the cache is forgotten: the position shows nothing until its next tile lands', () => {
    const fb = createFallbacks();
    const cache = createTileCache<string>(64, (_v, key) => fb.evicted(key));
    const get = (k: string) => cache.get(k);
    const at = [P(0, 0), P(0, 1)];
    cache.set('s1|256|0|0', 'A1');
    cache.set('s1|256|0|1', 'B1');
    fb.frame('biome', previews(at), keyOf('s1'), get);
    cache.setCapacity(1);   // evicts the least recently used: (0, 0)'s tile
    expect([fb.keyAt('biome', 256, 0, 0), fb.size]).toEqual([null, 1]);
    expect(drawn(fb.frame('biome', previews(at), keyOf('s2'), get))).toEqual(['s1|256|0|1 (fallback)']);
    // Lookups also drop a fallback whose tile is gone when nothing reported the eviction.
    const bare = createFallbacks();
    const map = new Map([['s1|256|0|0', 'A1']]);
    bare.frame('biome', previews([P(0, 0)]), keyOf('s1'), (k) => map.get(k));
    map.clear();
    expect(bare.frame('biome', previews([P(0, 0)]), keyOf('s2'), (k) => map.get(k)).draws).toEqual([]);
    expect(bare.size).toBe(0);
  });

  test('drawing a fallback refreshes its cache entry, so it outlives tiles that landed before it was drawn', () => {
    const fb = createFallbacks();
    const cache = createTileCache<string>(3, (_v, key) => fb.evicted(key));
    const get = (k: string) => cache.get(k);
    cache.set('s1|256|0|0', 'A1');
    fb.frame('biome', previews([P(0, 0)]), keyOf('s1'), get);
    cache.set('s2|256|5|5', 'x');
    cache.set('s2|256|6|6', 'y');
    fb.frame('biome', previews([P(0, 0)]), keyOf('s2'), get);   // draws the fallback: most recently used
    cache.set('s2|256|7|7', 'z');                                // evicts (5, 5), not the fallback
    expect([cache.get('s1|256|0|0'), cache.get('s2|256|5|5')]).toEqual(['A1', undefined]);
  });

  test('draw order: fallbacks coarse to fine, then the current source coarse to fine (a current preview covers a fallback fine tile)', () => {
    const fb = createFallbacks();
    const cache = new Map<string, string>();
    const get = (k: string) => cache.get(k);
    const levels: LevelTiles[] = [{ level: 256, tiles: [P(0, 0), P(1, 0)] }, { level: 64, tiles: [P(0, 0), P(1, 0)] }];
    for (const k of ['s1|256|0|0', 's1|256|1|0', 's1|64|0|0', 's1|64|1|0']) cache.set(k, k);
    fb.frame('biome', levels, keyOf('s1'), get);
    cache.set('s2|256|0|0', 'p');
    cache.set('s2|64|1|0', 'f');
    expect(drawn(fb.frame('biome', levels, keyOf('s2'), get))).toEqual([
      's1|256|1|0 (fallback)', 's1|64|0|0 (fallback)', 's2|256|0|0', 's2|64|1|0',
    ]);
  });

  test('fallbacks are per layer: a layer switch keeps the other layer\'s fallbacks', () => {
    const fb = createFallbacks();
    const cache = new Map<string, string>([['biome|s1|256|0|0', 'b'], ['relief|s1|256|0|0', 'r']]);
    const get = (k: string) => cache.get(k);
    fb.frame('biome', previews([P(0, 0)]), keyOf('biome|s1'), get);
    expect(fb.frame('relief', previews([P(0, 0)]), keyOf('relief|s2'), get).draws).toEqual([]);
    fb.frame('relief', previews([P(0, 0)]), keyOf('relief|s1'), get);
    expect(drawn(fb.frame('biome', previews([P(0, 0)]), keyOf('biome|s2'), get))).toEqual(['biome|s1|256|0|0 (fallback)']);
    expect(drawn(fb.frame('relief', previews([P(0, 0)]), keyOf('relief|s2'), get))).toEqual(['relief|s1|256|0|0 (fallback)']);
  });

  test('nearestCurrent: the longest nearest-first prefix of the preview positions showing the current source', () => {
    const fb = createFallbacks();
    const at = [P(0, 0), P(1, 0), P(0, 1), P(1, 1)];
    const cache = new Map<string, string>(at.map((p) => [`s1|256|${p.tx}|${p.tz}`, 'old'] as [string, string]));
    const get = (k: string) => cache.get(k);
    expect(fb.frame('biome', previews(at), keyOf('s1'), get).nearestCurrent).toBe(4);
    cache.set('s2|256|0|0', 'n');
    cache.set('s2|256|1|0', 'n');
    cache.set('s2|256|1|1', 'n');
    const f = fb.frame('biome', [...previews(at), { level: 64, tiles: [P(0, 0)] }], keyOf('s2'), get);
    expect(f.nearestCurrent).toBe(2);   // (0, 1) still shows its fallback
    expect(fb.frame('biome', previews(at), NO_SOURCE, get).nearestCurrent).toBe(0);
  });
});

describe('blank draws (SP2b spec §2.8)', () => {
  test('counted after the first image when a preview position that showed a tile in the previous draw of its layer shows none', () => {
    const fb = createFallbacks();
    const cache = new Map<string, string>();
    const get = (k: string) => cache.get(k);
    const at = [P(0, 0), P(1, 0)];
    cache.set('s1|256|0|0', 'a');
    expect(fb.frame('biome', previews(at), keyOf('s1'), get).blank).toBe(false);
    cache.delete('s1|256|0|0');
    expect(fb.frame('biome', previews(at), keyOf('s1'), get).blank).toBe(false);   // before the first image
    cache.set('s1|256|0|0', 'a');
    cache.set('s1|256|1|0', 'b');
    expect(fb.frame('biome', previews(at), keyOf('s1'), get).blank).toBe(false);   // the first image
    expect(fb.frame('biome', previews(at), keyOf('s2'), get).blank).toBe(false);   // fallbacks
    expect(fb.frame('relief', previews(at), keyOf('relief'), get).blank).toBe(false);   // nothing shown yet on relief
    cache.delete('s1|256|1|0');
    fb.evicted('s1|256|1|0');
    const f = fb.frame('biome', previews(at), keyOf('s2'), get);
    expect([f.blank, fb.blankDraws]).toEqual([true, 1]);
    expect(fb.frame('biome', previews(at), keyOf('s2'), get).blank).toBe(false);   // it showed nothing in the previous draw
    expect(fb.frame('biome', previews([P(5, 5), P(0, 0)]), keyOf('s2'), get).blank).toBe(false);   // newly exposed by a pan
    expect(fb.blankDraws).toBe(1);
  });
});

describe('zoomed out: more preview positions than workers (SP2b spec §2.5, §2.6, §8)', () => {
  /** Configure resolves on ready(); every source changes every stage hash, so every tile key changes. */
  interface SimPool extends DriverPool { epoch: number; configures: number; ready(): Promise<void> }
  const simPool = (size: number): SimPool => {
    let resolveNext: (() => void) | null = null;
    const pool: SimPool = {
      size, epoch: -1, configures: 0,
      configure() {
        pool.epoch += 1;
        pool.configures += 1;
        const e = pool.epoch;
        const h = `h${e}`;
        return new Promise((resolve) => { resolveNext = () => resolve({ epoch: e, stageHashes: { climate: h, shape: h, surfaceEst: h, biome2d: h, map: h } }); });
      },
      spawn: () => Promise.resolve<Spawn>({ x: 0, z: 0, y: 64, biome: 1, fallback: false }),
      async ready() { const r = resolveNext; resolveNext = null; r?.(); await flush(); },
    };
    return pool;
  };
  const clock: DriverClock = { now: () => 0, setTimeout: () => 0, clearTimeout: () => {} };
  const draft = (e: number): DriverDraft => ({ sessionEpoch: e, seedText: '42', seedKey: '42.0', params: PARAMS });

  /** The map canvas's tile logic with the real source, cache and fallbacks; tiles land when the test says so. */
  const simCanvas = (pool: SimPool, positions: readonly TilePos[]) => {
    const source = createTileSource();
    const fb: Fallbacks = createFallbacks();
    const cache = createTileCache<string>(3 * positions.length, (_v, key) => fb.evicted(key));
    const keyFor = (level: MapLevel, tx: number, tz: number) => source.keyFor('biome', level, tx, tz, pool.epoch);
    let driver: PreviewDriver | null = null;
    const canvas: DriverCanvas & { interactive: boolean } = {
      interactive: false,
      setSource(epoch, seedKey, hashes) { source.set(epoch, seedKey, hashes); },
      setInteractive(on) { canvas.interactive = on; },
      setSpawn() {},
    };
    return {
      canvas, fb,
      attach(d: PreviewDriver) { driver = d; },
      /** The pool finishes the `n` nearest preview tiles of the current source that are not cached yet. */
      land(n: number) {
        for (const p of positions) {
          if (n === 0) return;
          const key = keyFor(256, p.tx, p.tz);
          if (key === null || cache.get(key) !== undefined) continue;
          cache.set(key, `tile ${key}`);
          n--;
        }
      },
      /** One animation-frame draw: what the canvas shows, and its progress report to the driver. */
      draw(): Frame<string> {
        const f = fb.frame('biome', [{ level: 256, tiles: positions }], keyFor, (k) => cache.get(k));
        if (source.epoch !== null && source.epoch === pool.epoch) driver!.previewProgress(source.epoch, f.nearestCurrent, positions.length);
        return f;
      },
    };
  };

  test('a view with 9 preview positions, pool.size 6 and 10 gesture cycles never shows a blank position', async () => {
    const positions = visibleTiles({ x: 32768, z: 32768, bpp: 256, layer: 'biome' }, 768, 768, 256);
    expect(positions).toHaveLength(9);
    const pool = simPool(6);
    const sim = simCanvas(pool, positions);
    const driver = createPreviewDriver(pool, sim.canvas, clock);
    sim.attach(driver);
    // The first image: an urgent load lands once all 9 previews are drawn.
    driver.change(draft(0), { urgent: true, gesture: false, kind: 'load' }, 0);
    await pool.ready();
    sim.land(9);
    expect(sim.draw().draws).toHaveLength(9);
    expect(driver.status.settled).toBe(true);
    const first = positions.map((p) => sim.fb.keyAt('biome', 256, p.tx, p.tz));
    driver.change(draft(0), { urgent: false, gesture: true, kind: 'gestureBegin' }, 0);
    expect(sim.canvas.interactive).toBe(true);
    for (let i = 1; i <= 10; i++) {
      driver.change(draft(i), { urgent: false, gesture: true, kind: 'set' }, i);
      await pool.ready();
      const before = sim.draw();   // the new source has no tile yet: every position shows its fallback
      expect(before.draws.map((d) => d.fallback)).toEqual(Array(9).fill(true));
      sim.land(6);                 // the 6 workers finish the 6 nearest previews
      const after = sim.draw();    // the zoomed-out rule lands the gesture cycle on these 6
      expect(after.draws).toHaveLength(9);
      expect(after.draws.filter((d) => d.fallback)).toHaveLength(3);
      expect([after.nearestCurrent, driver.status.pending]).toEqual([6, false]);
    }
    expect(pool.configures).toBe(11);
    // The three farthest positions still show the first source's tiles, ten sources later.
    expect(positions.slice(6).map((p) => sim.fb.keyAt('biome', 256, p.tx, p.tz))).toEqual(first.slice(6));
    // The release needs no configure (same epoch); the full plan brings the far previews of the last source.
    driver.change(draft(10), { urgent: true, gesture: false, kind: 'gestureEnd' }, 11);
    expect([sim.canvas.interactive, driver.status.settled, pool.configures]).toEqual([false, true, 11]);
    sim.land(9);
    const last = sim.draw();
    expect([last.nearestCurrent, last.draws.some((d) => d.fallback)]).toEqual([9, false]);
    expect(sim.fb.blankDraws).toBe(0);
  });

  test('the map canvas is a DriverCanvas (the page passes it to the driver as is)', () => {
    const asDriverCanvas = (c: MapCanvas): DriverCanvas => c;
    expect(typeof asDriverCanvas).toBe('function');
  });
});
