import { describe, expect, test, vi } from 'vitest';
import { MAX_NAME, MAX_PLACES, normalizeState, type Place } from '../../src/persist/saves';
import { PLACE_COLOURS, PLACES_FULL_NOTICE, createPlaces, proposedPlaceName } from '../../src/ui/world/places';
import { STATE_BOUNDS } from '../../src/ui/world/stateBounds';

/** A place's fields but its id, at (x, 70, z). */
const at = (x: number, z: number, name = ''): Omit<Place, 'id'> => ({ name, colour: 0, x, y: 70, z, yaw: 10, pitch: -5 });

/** A places model whose ids are `p1`, `p2`, … in the order asked. */
const model = (initial: readonly Place[] = []) => {
  let n = 0;
  return createPlaces(initial, () => `p${++n}`);
};

describe('the places model (SP5b spec §3.7, D12)', () => {
  test('`proposedPlaceName(3, 312.7, 88.2, -1540.1)` is `Place 4 (312, 88, -1541)`', () => {
    expect(proposedPlaceName(3, 312.7, 88.2, -1540.1)).toBe('Place 4 (312, 88, -1541)');
    // Rounded down, and −0 prints as 0.
    expect(proposedPlaceName(0, -0.5, -0, 0.99)).toBe('Place 1 (-1, 0, 0)');
  });

  test('the eight colours are D12\'s, red first; the normaliser keeps every one of their indices', () => {
    expect(PLACE_COLOURS).toEqual(['#e5534b', '#e0a030', '#e8d44d', '#57ab5a', '#4aa3df', '#986ee2', '#e275ad', '#dddddd']);
    const places = PLACE_COLOURS.map((_, colour) => ({ id: `c${colour}`, name: 'n', colour, x: 0, y: 70, z: 0, yaw: 0, pitch: 0 }));
    expect(normalizeState({ places }, 'w', STATE_BOUNDS).state.places).toHaveLength(PLACE_COLOURS.length);
    expect(normalizeState({ places: [{ ...places[0], colour: PLACE_COLOURS.length }] }, 'w', STATE_BOUNDS).state.places).toEqual([]);
  });

  test('add keeps the place with a new id, its name trimmed; an empty name keeps the proposal', () => {
    const p = model();
    expect(p.add(at(1.5, 2.5, '  Home  '))).toEqual({ id: 'p1', name: 'Home', colour: 0, x: 1.5, y: 70, z: 2.5, yaw: 10, pitch: -5 });
    expect(p.add({ ...at(-3.2, 9.9), name: '   ', colour: 4 })).toEqual({ id: 'p2', name: 'Place 2 (-4, 70, 9)', colour: 4, x: -3.2, y: 70, z: 9.9, yaw: 10, pitch: -5 });
    expect(p.list.map((x) => x.id)).toEqual(['p1', 'p2']);
  });

  test('the 257th add answers \'full\'', () => {
    const p = model();
    for (let i = 0; i < MAX_PLACES; i++) expect(p.add(at(i, 0, `P${i}`)), `add ${i + 1}`).not.toBe('full');
    expect(MAX_PLACES).toBe(256);
    expect(p.add(at(999, 0, 'one too many'))).toBe('full');
    expect(p.list).toHaveLength(256);
    expect(p.list.some((x) => x.name === 'one too many')).toBe(false);
    expect(PLACES_FULL_NOTICE).toBe('A world holds at most 256 places');
  });

  test('edit cuts a 70-character name to 64', () => {
    const p = model();
    const a = p.add(at(0, 0, 'A')) as Place;
    p.edit(a.id, `  ${'x'.repeat(70)}  `, 5);
    expect(MAX_NAME).toBe(64);
    expect(p.list[0]).toEqual({ ...a, name: 'x'.repeat(64), colour: 5 });
    // An empty name keeps the place's name; an unknown id changes nothing.
    p.edit(a.id, ' ', 2);
    expect(p.list[0]).toEqual({ ...a, name: 'x'.repeat(64), colour: 2 });
    const before = p.list;
    p.edit('nope', 'B', 1);
    expect(p.list).toBe(before);
    // add cuts the same way, by characters (a code point is one).
    expect((p.add(at(0, 0, '🙂'.repeat(70))) as Place).name).toBe('🙂'.repeat(64));
  });

  test('remove returns the place', () => {
    const p = model();
    const a = p.add(at(0, 0, 'A')) as Place;
    const b = p.add(at(1, 1, 'B')) as Place;
    expect(p.remove(a.id)).toEqual(a);
    expect(p.list).toEqual([b]);
    expect(p.remove(a.id)).toBeNull();
    expect(p.list).toEqual([b]);
  });

  test('every change hands a new list object and notifies; the initial places are kept in order; no change notifies nothing (rulings R9)', () => {
    const initial: Place[] = [{ id: 'old', name: 'Old', colour: 3, x: 5, y: 6, z: 7, yaw: 8, pitch: 9 }];
    const p = model(initial);
    expect(p.list).toEqual(initial);
    expect(p.list).not.toBe(initial);
    const seen: Array<readonly Place[]> = [p.list];
    const f = vi.fn(() => { seen.push(p.list); });
    const off = p.subscribe(f);
    const a = p.add(at(0, 0, 'A')) as Place;
    p.edit(a.id, 'A2', 1);
    p.remove('old');
    expect(f).toHaveBeenCalledTimes(3);
    expect(new Set(seen).size).toBe(4);
    // A refused change (unknown id, full) hands no new list and notifies nothing.
    p.edit('nope', 'x', 0);
    p.remove('nope');
    expect(f).toHaveBeenCalledTimes(3);
    off();
    p.add(at(1, 1));
    expect(f).toHaveBeenCalledTimes(3);
    // The initial array is never changed in place.
    expect(initial).toEqual([{ id: 'old', name: 'Old', colour: 3, x: 5, y: 6, z: 7, yaw: 8, pitch: 9 }]);
  });
});
