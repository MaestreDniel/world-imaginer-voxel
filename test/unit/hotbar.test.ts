import { describe, expect, test } from 'vitest';
import { createHotbar, DEFAULT_HOTBAR, HOTBAR_KEY, normalizeHotbar, slotName } from '../../src/player/hotbar';

/** A `localStorage` stand-in over a Map, counting writes. */
function memoryStorage(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  let writes = 0;
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { writes++; m.set(k, v); },
    get writes() { return writes; },
    stored: (): unknown => JSON.parse(m.get(HOTBAR_KEY)!),
  };
}

const NAMES = ['stone', 'dirt', 'grass_block', 'oak_planks', 'glass', 'oak_log', 'torch'];

describe('the hotbar (SP5a spec §4.3, D9)', () => {
  test('defaults; `select(4)`; `step(1)` from 8 wraps to 0', () => {
    expect(DEFAULT_HOTBAR).toEqual([...NAMES.map((type) => ({ type, pinned: {} })), { fluid: 'water' }, { fluid: 'lava' }]);
    const h = createHotbar(null);
    expect(h.slots).toEqual(DEFAULT_HOTBAR);
    expect(h.active).toBe(0);
    h.select(4);
    expect(h.active).toBe(4);
    h.select(8);
    h.step(1);
    expect(h.active).toBe(0);
    h.step(-1);
    expect(h.active).toBe(8);
    h.select(9);
    h.select(-1);
    h.select(2.5);
    expect(h.active).toBe(8);
  });

  test('`assign` writes the active slot and stores at once', () => {
    const s = memoryStorage();
    const h = createHotbar(s);
    let changes = 0;
    const off = h.subscribe(() => { changes++; });
    h.select(3);
    expect(s.writes).toBe(1);
    h.assign({ type: 'bricks', pinned: {} });
    expect(h.slots[3]).toEqual({ type: 'bricks', pinned: {} });
    expect(h.active).toBe(3);
    expect(s.writes).toBe(2);
    expect((s.stored() as { slots: unknown[] }).slots[3]).toEqual({ type: 'bricks', pinned: {} });
    h.assign({ tool: 'emptyBucket' });
    expect(h.slots[3]).toEqual({ tool: 'emptyBucket' });
    expect(changes).toBe(3);
    off();
    h.select(0);
    expect(changes).toBe(3);
    // A storage that throws (quota, private mode) leaves the hotbar working for this page.
    const throwing = createHotbar({ getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('quota'); } });
    throwing.select(2);
    expect(throwing.active).toBe(2);
  });

  test('round-trip through `wi.world.hotbar` by name, the stored block slots carrying `pinned: {}`', () => {
    const s = memoryStorage();
    const h = createHotbar(s);
    h.select(6);
    h.assign({ type: 'white_wool', pinned: {} });
    h.select(1);
    expect(s.stored()).toEqual({
      v: 1,
      active: 1,
      slots: [
        ...NAMES.slice(0, 6).map((type) => ({ type, pinned: {} })),
        { type: 'white_wool', pinned: {} },
        { fluid: 'water' },
        { fluid: 'lava' },
      ],
    });
    const again = createHotbar(s);
    expect(again.active).toBe(1);
    expect(again.slots).toEqual(h.slots);
    expect(again.slots[6]).toEqual({ type: 'white_wool', pinned: {} });
  });

  test('an unknown name normalised to the default slot; a missing `pinned` normalised to `{}`', () => {
    const raw = {
      v: 1,
      active: 5,
      slots: [
        { type: 'no_such_block', pinned: {} },
        { type: 'bricks' },
        { type: 'wall_torch', pinned: {} },
        { type: 'ice', pinned: 'north' },
        { fluid: 'milk' },
        { tool: 'emptyBucket' },
        null,
        { type: 'stone', pinned: { facing: 'north' } },
      ],
    };
    const n = normalizeHotbar(raw);
    expect(n.active).toBe(5);
    expect(n.slots).toEqual([
      DEFAULT_HOTBAR[0],
      { type: 'bricks', pinned: {} },
      DEFAULT_HOTBAR[2], // wall_torch is not placeable
      { type: 'ice', pinned: {} }, // a non-object `pinned`
      DEFAULT_HOTBAR[4], // a malformed slot
      { tool: 'emptyBucket' },
      DEFAULT_HOTBAR[6],
      { type: 'stone', pinned: {} }, // a prop stone does not have
      DEFAULT_HOTBAR[8], // missing
    ]);
    expect(normalizeHotbar({ v: 1, active: 9, slots: [] }).active).toBe(0);
    expect(normalizeHotbar('garbage')).toEqual({ active: 0, slots: [...DEFAULT_HOTBAR] });
    expect(normalizeHotbar({ v: 2, active: 3, slots: [] })).toEqual({ active: 0, slots: [...DEFAULT_HOTBAR] });
    const h = createHotbar(memoryStorage({ [HOTBAR_KEY]: JSON.stringify(raw) }));
    expect(h.slots[0]).toEqual({ type: 'stone', pinned: {} });
    expect(createHotbar(memoryStorage({ [HOTBAR_KEY]: '{not json' })).slots).toEqual(DEFAULT_HOTBAR);
  });

  test("`pick('torch')` selects the slot holding torch; `pick('bricks')` puts bricks in the active slot", () => {
    const s = memoryStorage();
    const h = createHotbar(s);
    let changes = 0;
    h.subscribe(() => { changes++; });
    h.select(1);
    h.pick('torch');
    expect(h.active).toBe(6);
    expect(h.slots).toEqual(DEFAULT_HOTBAR);
    h.pick('torch');
    expect(changes).toBe(2); // the active slot already holds it: no change
    h.pick('bricks');
    expect(h.active).toBe(6);
    expect(h.slots[6]).toEqual({ type: 'bricks', pinned: {} });
    expect((s.stored() as { slots: unknown[] }).slots[6]).toEqual({ type: 'bricks', pinned: {} });
    h.pick('wall_torch'); // not placeable (pick names a wall torch `torch`)
    expect(h.slots[6]).toEqual({ type: 'bricks', pinned: {} });
  });

  test('slot names: the block\'s display name, and the buckets', () => {
    expect(DEFAULT_HOTBAR.map(slotName)).toEqual(['Stone', 'Dirt', 'Grass block', 'Oak planks', 'Glass', 'Oak log', 'Torch', 'Water bucket', 'Lava bucket']);
    expect(slotName({ tool: 'emptyBucket' })).toBe('Empty bucket');
  });
});
