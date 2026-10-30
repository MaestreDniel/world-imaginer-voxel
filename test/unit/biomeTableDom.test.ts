/**
 * The biome table's DOM in a saved world's modification mode (SP5b spec D10, D25), on the DOM shim with a real session:
 * `setEditable(false)` disables every row's fields, sign select and reset and the table's Reset, and a bar's press no
 * longer begins a drag; the sort and the family filter stay. A control disabled for its own reason (a row or the table
 * with nothing to reset) stays disabled when the mode is on again.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { WorldSession } from '../../src/engine/session';
import { validateParamTrees } from '../../src/gen/trees';
import { BIOME_TABLE_PATH } from '../../src/ui/biomeTable/model';
import { createBiomeTable } from '../../src/ui/biomeTable/table';
import { FakeElement, installDom } from './fixtures/domShim';

afterEach(() => { vi.unstubAllGlobals(); });

function mount() {
  const dom = installDom();
  // The table keeps the focus across a re-order with `instanceof HTMLElement`.
  vi.stubGlobal('HTMLElement', FakeElement);
  const session = new WorldSession(() => [1, 2], { validateParams: validateParamTrees });
  const host = dom.document.createElement('div');
  const table = createBiomeTable(host as unknown as HTMLElement, { session, edit: (_e, fn) => fn(), hover: () => {} });
  const by = (cls: string): FakeElement[] => all(host).filter((e) => e.className.split(' ').includes(cls));
  return { session, host, table, by };
}

/** Every descendant of `host`. */
function all(host: FakeElement): FakeElement[] {
  const out: FakeElement[] = [];
  const walk = (e: FakeElement): void => { for (const c of e.children) { out.push(c); walk(c); } };
  walk(host);
  return out;
}

describe('the biome table\'s setEditable (SP5b spec D10)', () => {
  test('false disables the interval and priority fields, the sign selects, the row resets and Reset table; sort and filter stay; true enables them again', () => {
    const { session, table, by } = mount();
    // A modified row: its reset and Reset table are enabled.
    const t = session.state.params.biomes.table;
    const name = Object.keys(t)[0] as keyof typeof t;
    session.set(BIOME_TABLE_PATH, { ...t, [name]: { ...t[name], priority: 999 } });
    const edits = [...by('bt-field'), ...by('bt-wsign')];
    expect(edits.length).toBeGreaterThan(0);
    expect(edits.every((c) => !c.disabled)).toBe(true);
    const enabledResets = [...by('bt-reset'), ...by('bt-reset-all')].filter((b) => !b.disabled);
    expect(enabledResets).toHaveLength(2);
    const looking = [...by('bt-sort'), ...by('bt-filter')];
    expect(looking).toHaveLength(2);

    table.setEditable(false);
    expect(edits.filter((c) => !c.disabled)).toEqual([]);
    expect([...by('bt-reset'), ...by('bt-reset-all')].filter((b) => !b.disabled)).toEqual([]);
    expect(looking.every((c) => !c.disabled)).toBe(true);
    // A bar's press on its lo end, then a move, begins no drag (a div cannot be disabled): no gesture, no edit.
    const bar = by('bt-bar')[0]!;
    Object.assign(bar, { clientWidth: 200, clientLeft: 0 });
    const before = session.state;
    const lo = (session.state.params.biomes.table[bar.parentElement!.parentElement!.dataset['biome'] as keyof typeof t].C[0] + 1) * 100;
    const pointer = (type: string, clientX: number) => bar.dispatchEvent(Object.assign(new Event(type), { button: 0, pointerId: 1, clientX }));
    pointer('pointerdown', lo);
    pointer('pointermove', lo + 40);
    pointer('pointerup', lo + 40);
    expect([session.inGesture, session.state, bar.captured.size]).toEqual([false, before, 0]);

    table.setEditable(true);
    expect(edits.every((c) => !c.disabled)).toBe(true);
    expect([...by('bt-reset'), ...by('bt-reset-all')].filter((b) => !b.disabled)).toEqual(enabledResets);
  });

  test('a row reset and Reset table with nothing to reset stay disabled after `setEditable(true)`', () => {
    const { table, by } = mount();
    const resets = [...by('bt-reset'), ...by('bt-reset-all')];
    expect(resets.length).toBeGreaterThan(1);
    expect(resets.every((b) => b.disabled)).toBe(true);
    table.setEditable(false);
    table.setEditable(true);
    expect(resets.every((b) => b.disabled)).toBe(true);
    expect(by('bt-field').every((c) => !c.disabled)).toBe(true);
  });
});
