import { describe, expect, test } from 'vitest';
import { utf8Bytes } from '../../src/core/hash';
import { base64urlEncode } from '../../src/ui/common/base64url';
import { decodeMapState, DEFAULT_MAP_STATE, encodeMapState, type MapState } from '../../src/ui/map/mapState';
import { createTileCache, tileKey } from '../../src/ui/map/tileCache';
import { planTiles, screenToWorld, visibleTiles, worldToScreen } from '../../src/ui/map/viewMath';

const enc = (o: unknown) => `#${base64urlEncode(utf8Bytes(JSON.stringify(o)))}`;

describe('map URL state', () => {
  test('round-trips, trimming the seed and normalising −0', () => {
    const s: MapState = { v: 1, seed: ' 7 ', profile: 'large_biomes', patch: { rivers: { widthMin: 6 } }, view: { x: -0, z: 1024.5, bpp: 16, layer: 'relief' } };
    const back = decodeMapState(`#${encodeMapState(s)}`);
    expect(back.error).toBeNull();
    expect(back.state).toEqual({ ...s, seed: '7', view: { ...s.view, x: 0 } });
  });
  test('an empty hash is the default without a notice', () => {
    expect(decodeMapState('')).toEqual({ state: DEFAULT_MAP_STATE, error: null });
  });
  test.each<[string, string]>([
    ['bad base64', '#***'],
    ['not JSON', enc('{x')],
    ['unknown key', enc({ ...DEFAULT_MAP_STATE, extra: 1 })],
    ['wrong version', enc({ ...DEFAULT_MAP_STATE, v: 2 })],
    ['empty seed', enc({ ...DEFAULT_MAP_STATE, seed: ' ' })],
    ['seed with a line break', enc({ ...DEFAULT_MAP_STATE, seed: 'a\nb' })],
    ['unknown profile', enc({ ...DEFAULT_MAP_STATE, profile: 'nope' })],
    ['profile not ready', enc({ ...DEFAULT_MAP_STATE, profile: 'archipelago' })],
    ['invalid patch', enc({ ...DEFAULT_MAP_STATE, patch: { rivers: { widthMin: 999 } } })],
    ['view outside the window', enc({ ...DEFAULT_MAP_STATE, view: { ...DEFAULT_MAP_STATE.view, x: 1e7 } })],
    ['zoom out of range', enc({ ...DEFAULT_MAP_STATE, view: { ...DEFAULT_MAP_STATE.view, bpp: 1000 } })],
    ['unknown layer', enc({ ...DEFAULT_MAP_STATE, view: { ...DEFAULT_MAP_STATE.view, layer: 'caves' } })],
  ])('%s falls back to the defaults with a notice', (_n, hash) => {
    const r = decodeMapState(hash);
    expect(r.state).toEqual(DEFAULT_MAP_STATE);
    expect(r.error).toMatch(/^map URL ignored: /);
  });
});

describe('view math', () => {
  const v = { x: 1000, z: -500, bpp: 64, layer: 'biome' as const };
  test('screen ↔ world round-trips', () => {
    const [x, z] = screenToWorld(v, 800, 600, 123, 45);
    expect(worldToScreen(v, 800, 600, x, z)).toEqual([123, 45]);
    expect(screenToWorld(v, 800, 600, 400, 300)).toEqual([1000, -500]);
  });
  test('visible tiles cover the view, nearest first', () => {
    const t = visibleTiles(v, 800, 600, 64);
    expect(t.length).toBe(16);
    expect(t[0]).toMatchObject({ tx: 0, tz: -1 });
    expect(visibleTiles({ ...v, x: 0, z: 0 }, 512, 512, 256)).toEqual([
      { tx: -1, tz: -1, dist: Math.SQRT1_2 }, { tx: 0, tz: -1, dist: Math.SQRT1_2 }, { tx: -1, tz: 0, dist: Math.SQRT1_2 }, { tx: 0, tz: 0, dist: Math.SQRT1_2 },
    ]);
  });
  test('only tiles inside the half-open colKey window [−2^19, 2^19) are planned (view at the world edge)', () => {
    const inside = (t: number, level: number) => t * 256 * level >= -524288 && (t + 1) * 256 * level <= 524288;
    for (const edge of [{ x: 524288, z: -524288, bpp: 256, layer: 'biome' as const }, { x: -524288, z: 524288, bpp: 256, layer: 'biome' as const }]) {
      const plan = planTiles(edge, 1400, 900);
      expect(plan.length).toBeGreaterThan(0);
      expect(plan.every((t) => inside(t.tx, t.level) && inside(t.tz, t.level))).toBe(true);
      expect(planTiles({ ...edge, bpp: 4 }, 1400, 900).every((t) => inside(t.tx, t.level) && inside(t.tz, t.level))).toBe(true);
    }
  });
  test('the plan asks for the preview level before the view level', () => {
    const p = planTiles(v, 800, 600);
    const firstFine = p.findIndex((t) => t.level !== 256);
    expect(p.slice(0, firstFine).every((t) => t.level === 256)).toBe(true);
    expect(p.slice(firstFine).every((t) => t.level === 64 && t.priority >= 1000)).toBe(true);
    expect(planTiles({ ...v, bpp: 200 }, 800, 600).every((t) => t.level === 256)).toBe(true);
  });
  test('the interactive plan asks only for the preview level, with the full plan\'s priorities (SP2b §2.6)', () => {
    const full = planTiles(v, 800, 600);
    const interactive = planTiles(v, 800, 600, true);
    expect(interactive.length).toBeGreaterThan(0);
    expect(interactive).toEqual(full.filter((t) => t.level === 256));
    expect(planTiles(v, 800, 600, false)).toEqual(full);
  });
});

describe('tile cache', () => {
  test('LRU with eviction callback; keys include the layer hash', () => {
    const evicted: number[] = [];
    const c = createTileCache<number>(2, (v) => evicted.push(v));
    c.set('a', 1);
    c.set('b', 2);
    c.get('a');
    c.set('c', 3);
    expect([c.get('b'), c.get('a'), c.size]).toEqual([undefined, 1, 2]);
    expect(evicted).toEqual([2]);
    c.clear();
    expect(evicted.sort()).toEqual([1, 2, 3]);
    expect(tileKey('biome', 64, -1, 2, 'abc')).toBe('biome|64|-1|2|abc');
  });
});
