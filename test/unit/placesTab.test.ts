import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Place } from '../../src/persist/saves';
import type { NoticeOptions } from '../../src/ui/common/notice';
import { mountPlacesTab } from '../../src/ui/map/placesTab';
import { createPlaces, PLACE_COLOURS } from '../../src/ui/world/places';
import { installDom, type FakeElement } from './fixtures/domShim';

describe('mountPlacesTab: the map\'s Places tab in a saved world (SP5b spec §3.7, D13; ruling P34)', () => {
  let dom: ReturnType<typeof installDom>;
  beforeEach(() => { dom = installDom(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  const saved: Place[] = [
    { id: 'a', name: 'Big canyon', colour: 0, x: 120.25, y: 88.62, z: -40.5, yaw: 33, pitch: -12.5 },
    { id: 'b', name: 'Island house', colour: 4, x: -512.75, y: 64.1, z: 900.5, yaw: 271.25, pitch: 4 },
    { id: 'c', name: 'Jungle edge', colour: 3, x: 3.5, y: 70, z: 7.5, yaw: 0, pitch: 0 },
  ];

  /** The tab over a real places model, a pin source the test sets (a Shift+click), and the calls it makes. */
  function setup(o: { pin?: readonly [number, number] | null } = {}) {
    const host = dom.document.createElement('div');
    dom.body.append(host);
    let n = 0;
    const places = createPlaces(saved, () => `p${++n}`);
    let pin = o.pin ?? null;
    const pinFns = new Set<(p: readonly [number, number] | null) => void>();
    const teleported: Place[] = [];
    const added: Array<[number, number]> = [];
    const shown: Array<[string, NoticeOptions | undefined]> = [];
    const tab = mountPlacesTab(host as unknown as HTMLElement, {
      places,
      teleport: (p) => { teleported.push(p); },
      pin: {
        get: () => pin,
        subscribe(f) {
          pinFns.add(f);
          return () => { pinFns.delete(f); };
        },
      },
      addAt: (x, z) => { added.push([x, z]); },
      notices: { show: (text, opts) => { shown.push([text, opts]); } },
    });
    /** A Shift+click on the map: the tool's pin callback. */
    const setPin = (p: readonly [number, number] | null): void => {
      pin = p;
      for (const f of [...pinFns]) f(p);
    };
    return { host, places, tab, teleported, added, shown, setPin, pinFns };
  }
  const rows = (): FakeElement[] => dom.el('places-list').querySelectorAll('li');
  const buttonOf = (row: FakeElement, cls: string): FakeElement => {
    const b = row.querySelectorAll('button').find((e) => e.classList.contains(cls));
    if (b === undefined) throw new Error(`no .${cls} button in the row`);
    return b;
  };
  const partOf = (row: FakeElement, cls: string): FakeElement => {
    const e = [...row.querySelectorAll('span'), ...row.querySelectorAll('input')].find((x) => x.classList.contains(cls));
    if (e === undefined) throw new Error(`no .${cls} in the row`);
    return e;
  };
  const swatches = (row: FakeElement): FakeElement[] => row.querySelectorAll('button').filter((b) => b.classList.contains('place-swatch'));

  test('Enter or Esc during IME composition in the name field is left to the composition: nothing saved or cancelled (PAGE-4)', () => {
    const s = setup();
    buttonOf(rows()[0]!, 'place-edit').click();
    const name = partOf(rows()[0]!, 'place-edit-name');
    name.value = '大峡谷';
    // Safari can report key 'Enter' for the composition-commit Enter; `isComposing` is set in every engine.
    for (const k of ['Enter', 'Escape']) {
      const e = Object.assign(new Event('keydown', { cancelable: true }), { key: k, code: k, isComposing: true });
      partOf(rows()[0]!, 'place-edit-name').dispatchEvent(e);
      expect(e.defaultPrevented).toBe(false);
    }
    expect(s.places.list[0]).toEqual(saved[0]);
    expect(partOf(rows()[0]!, 'place-edit-name').value).toBe('大峡谷');
  });

  test('lists in saved order; ↗ teleports with the exact pose; ✎ edits name and colour; 🗑 deletes with `Deleted \'name\'`; `+ Add at the pin` disabled until a pin is set; a failed landing opens no dialog', () => {
    const s = setup();
    // The places in the order saved, each "● name" with the dot in its colour, and ↗ ✎ 🗑.
    expect(rows().map((r) => partOf(r, 'place-name').textContent)).toEqual(['Big canyon', 'Island house', 'Jungle edge']);
    expect(rows().map((r) => partOf(r, 'place-dot').textContent)).toEqual(['●', '●', '●']);
    expect(rows().map((r) => partOf(r, 'place-dot').style['color'])).toEqual([PLACE_COLOURS[0], PLACE_COLOURS[4], PLACE_COLOURS[3]]);
    expect(rows().map((r) => ['place-go', 'place-edit', 'place-delete'].map((c) => buttonOf(r, c).textContent))).toEqual(Array(3).fill(['↗', '✎', '🗑']));
    expect(buttonOf(rows()[1]!, 'place-go').getAttribute('aria-label')).toBe('Teleport to Island house');

    // ↗ hands the place itself to the teleport: its exact position and look.
    buttonOf(rows()[1]!, 'place-go').click();
    expect(s.teleported).toEqual([saved[1]]);

    // ✎ edits inline: the name and the 8 colours with the place's own pressed; Cancel changes nothing.
    buttonOf(rows()[0]!, 'place-edit').click();
    const name = partOf(rows()[0]!, 'place-edit-name');
    expect(name.value).toBe('Big canyon');
    expect(swatches(rows()[0]!)).toHaveLength(8);
    expect(swatches(rows()[0]!).map((b) => b.getAttribute('aria-pressed'))).toEqual(['true', ...Array(7).fill('false')]);
    name.value = 'Not kept';
    buttonOf(rows()[0]!, 'place-edit-cancel').click();
    expect(s.places.list[0]).toEqual(saved[0]);
    expect(partOf(rows()[0]!, 'place-name').textContent).toBe('Big canyon');
    // Save keeps the typed name and the chosen colour, in place; the row shows them.
    buttonOf(rows()[0]!, 'place-edit').click();
    partOf(rows()[0]!, 'place-edit-name').value = 'Canyon rim';
    swatches(rows()[0]!)[5]!.click();
    expect(swatches(rows()[0]!).map((b) => b.getAttribute('aria-pressed'))).toEqual([...Array(5).fill('false'), 'true', 'false', 'false']);
    buttonOf(rows()[0]!, 'place-edit-save').click();
    expect(s.places.list[0]).toEqual({ ...saved[0], name: 'Canyon rim', colour: 5 });
    expect(partOf(rows()[0]!, 'place-name').textContent).toBe('Canyon rim');
    expect(partOf(rows()[0]!, 'place-dot').style['color']).toBe(PLACE_COLOURS[5]);
    // Enter in the name field saves; Esc cancels and is consumed (the tool's Esc closes the drawer otherwise).
    buttonOf(rows()[2]!, 'place-edit').click();
    partOf(rows()[2]!, 'place-edit-name').value = 'Jungle';
    partOf(rows()[2]!, 'place-edit-name').dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { key: 'Enter', code: 'Enter' }));
    expect(s.places.list[2]!.name).toBe('Jungle');
    buttonOf(rows()[2]!, 'place-edit').click();
    partOf(rows()[2]!, 'place-edit-name').value = 'Not kept';
    const esc = Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape', code: 'Escape' });
    partOf(rows()[2]!, 'place-edit-name').dispatchEvent(esc);
    expect(esc.defaultPrevented).toBe(true);
    expect(s.places.list[2]!.name).toBe('Jungle');
    expect(rows()[2]!.querySelectorAll('input')).toHaveLength(0);

    // 🗑 deletes at once (no confirmation) with "Deleted 'name'".
    buttonOf(rows()[1]!, 'place-delete').click();
    expect(s.places.list.map((p) => p.id)).toEqual(['a', 'c']);
    expect(rows().map((r) => partOf(r, 'place-name').textContent)).toEqual(['Canyon rim', 'Jungle']);
    expect(s.shown).toEqual([['Deleted \'Island house\'', { timeoutMs: 4000 }]]);

    // "+ Add at the pin" is disabled with no pin; clicking it then does nothing.
    const add = dom.el('places-add');
    expect(add.textContent).toBe('+ Add at the pin');
    expect(add.disabled).toBe(true);
    add.click();
    expect(s.added).toEqual([]);
    s.tab.dispose();

    // Mounted with a pin already set, it is enabled and adds at the pin's x and z (the page's `addAt` asks the landing;
    // a failed one opens no dialog: `worldPage.test.ts`, ruling P34).
    const p = setup({ pin: [100.25, -20.75] });
    expect(dom.el('places-add').disabled).toBe(false);
    dom.el('places-add').click();
    expect(p.added).toEqual([[100.25, -20.75]]);
    p.tab.dispose();
  });

  test('the pin callback (a Shift+click) enables `+ Add at the pin` on the mounted tab; `dispose` unsubscribes', () => {
    const s = setup();
    expect(s.pinFns.size).toBe(1);
    expect(dom.el('places-add').disabled).toBe(true);
    s.setPin([7.5, 9.25]);
    expect(dom.el('places-add').disabled).toBe(false);
    dom.el('places-add').click();
    expect(s.added).toEqual([[7.5, 9.25]]);
    // A place added elsewhere (B in split mode) is listed at once.
    s.places.add({ name: 'Camp', colour: 1, x: 1, y: 2, z: 3, yaw: 4, pitch: 5 });
    expect(rows().map((r) => partOf(r, 'place-name').textContent)).toEqual(['Big canyon', 'Island house', 'Jungle edge', 'Camp']);
    s.tab.dispose();
    expect(s.pinFns.size).toBe(0);
    expect(s.host.children).toHaveLength(0);
    // Disposed, a later change of the places renders nothing.
    s.places.remove('a');
    expect(s.host.children).toHaveLength(0);
  });

  test('an empty list says how to add a place', () => {
    const host = dom.document.createElement('div');
    dom.body.append(host);
    const tab = mountPlacesTab(host as unknown as HTMLElement, {
      places: createPlaces([], () => 'x'),
      teleport() {},
      pin: { get: () => null, subscribe: () => () => {} },
      addAt() {},
      notices: { show() {} },
    });
    expect(rows()).toHaveLength(0);
    expect(dom.el('places-empty').hidden).toBe(false);
    expect(dom.el('places-empty').textContent).toBe('No places yet: B saves where you are, or set a pin with Shift+click.');
    tab.dispose();
  });
});
