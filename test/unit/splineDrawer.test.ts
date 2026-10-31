/**
 * The spline drawer's DOM in a saved world's modification mode (SP5b spec D10, D25), on the DOM shim with a real session
 * on `shape.offset`: `setEditable(false)` disables the edits (auto tangents, Reset spline, Import shape, the knot's Delete
 * and its x, y and d fields, the knot menu's nest, flatten and delete) and a knot press begins no drag; Export shape,
 * Close, Open, the breadcrumbs and the probes stay. A control disabled for its own reason (Reset spline with nothing
 * modified, a nested knot's y) stays disabled when the mode is on again. The plot is drawn at 600 × 300 through a stub
 * ResizeObserver; presses land on the knots' drawn centres.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { WorldSession } from '../../src/engine/session';
import { validateParamTrees } from '../../src/gen/trees';
import type { Notices } from '../../src/ui/common/notice';
import { createSplineDrawer } from '../../src/ui/splineEditor/drawer';
import { shapeText } from '../../src/ui/splineEditor/shapeFile';
import { installDom, type FakeElement } from './fixtures/domShim';

/** Every descendant of `host`. */
function all(host: FakeElement): FakeElement[] {
  const out: FakeElement[] = [];
  const walk = (e: FakeElement): void => { for (const c of e.children) { out.push(c); walk(c); } };
  walk(host);
  return out;
}

let observers: Array<() => void> = [];
beforeEach(() => {
  observers = [];
  vi.stubGlobal('ResizeObserver', class {
    constructor(cb: () => void) { observers.push(cb); }
    observe(): void {}
    disconnect(): void {}
  });
  // Lints wait for a frame that never comes: they are not what this file tests.
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  const win = new EventTarget();
  vi.stubGlobal('addEventListener', win.addEventListener.bind(win));
  vi.stubGlobal('removeEventListener', win.removeEventListener.bind(win));
  vi.stubGlobal('innerWidth', 1920);
  vi.stubGlobal('innerHeight', 1080);
});
afterEach(() => { vi.unstubAllGlobals(); });

function mount() {
  const dom = installDom();
  const session = new WorldSession(() => [1, 2], { validateParams: validateParamTrees });
  const host = dom.document.createElement('div');
  const drawer = createSplineDrawer(host as unknown as HTMLElement, {
    session,
    notices: { show: () => {} } as unknown as Notices,
    pool: { stats: () => new Promise(() => {}) },
    driver: { onSettled: () => () => {}, status: { settled: false } as never },
    edit: (_e, fn) => fn(),
    visible: () => true,
    close: () => {},
  });
  drawer.open('shape.offset');
  const by = (cls: string): FakeElement[] => all(host).filter((e) => e.className.split(' ').includes(cls));
  // The plot's host is 600 × 300: the observer's callback measures it and draws.
  by('sd-plotwrap')[0]!.rect = { left: 0, top: 0, width: 600, height: 300 };
  for (const cb of observers) cb();
  const plot = by('sd-plot')[0]!;
  const button = (text: string): FakeElement => all(host).find((e) => e.tagName === 'BUTTON' && e.textContent === text)!;
  const field = (f: 'x' | 'y' | 'd'): FakeElement => all(host).find((e) => e.id === `sd-knot-${f}`)!;
  /** The knots as drawn: their centres and whether each is nested. */
  const knots = () => by('sd-knot').map((k) => ({ x: Number(k.getAttribute('cx')), y: Number(k.getAttribute('cy')), nested: k.className.includes('sd-nested') }));
  const at = (type: string, k: { x: number; y: number }, extra: object = {}) =>
    plot.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), { button: 0, pointerId: 1, clientX: k.x, clientY: k.y, ...extra }));
  const menuItems = (): Map<string, boolean> => new Map(by('sd-menu')[0]!.children.map((b) => [b.textContent.startsWith('Nest by') ? 'Nest by' : b.textContent, b.disabled]));
  return { session, host, drawer, by, plot, button, field, knots, at, menuItems };
}

describe('the spline drawer\'s setEditable (SP5b spec D10)', () => {
  test('false disables the edits and the knot menu\'s nest, flatten and delete; Export, Close, Open and the breadcrumbs stay; true enables them again', () => {
    const d = mount();
    const nested = d.knots().find((k) => k.nested)!;
    const plain = d.knots().find((k) => !k.nested)!;
    expect([nested, plain].every((k) => k !== undefined)).toBe(true);
    // A right-click on a plain knot selects it and opens its menu.
    d.at('contextmenu', plain, { button: 2 });
    expect(d.menuItems()).toEqual(new Map([['Nest by', false], ['Delete knot', false]]));
    const edits = () => [
      d.button('Auto tangents: node'), d.button('Auto tangents: spline'), d.button('Import shape'), d.button('Delete'),
      d.field('x'), d.field('y'), d.field('d'),
    ];
    expect(edits().map((c) => c.disabled)).toEqual([false, false, false, false, false, false, false]);

    d.drawer.setEditable(false);
    expect(edits().map((c) => c.disabled)).toEqual([true, true, true, true, true, true, true]);
    expect(d.button('Reset spline').disabled).toBe(true);
    for (const t of ['Export shape', 'Close']) expect(d.button(t).disabled, t).toBe(false);
    expect(d.by('sd-crumb').every((b) => !b.disabled)).toBe(true);
    // The menu opened before is closed; opened again, its edits are disabled and Open stays.
    expect(d.by('sd-menu')[0]!.hidden).toBe(true);
    d.at('contextmenu', plain, { button: 2 });
    expect(d.menuItems()).toEqual(new Map([['Nest by', true], ['Delete knot', true]]));
    d.at('contextmenu', nested, { button: 2 });
    expect(d.menuItems()).toEqual(new Map([['Open', false], ['Flatten at the probe', true], ['Delete knot', true]]));
    expect(d.button('Open').hidden).toBe(false);
    expect(d.button('Open').disabled).toBe(false);

    d.drawer.setEditable(true);
    d.at('contextmenu', plain, { button: 2 });
    expect(d.menuItems()).toEqual(new Map([['Nest by', false], ['Delete knot', false]]));
    expect(edits().map((c) => c.disabled)).toEqual([false, false, false, false, false, false, false]);
  });

  test('while false a knot press and move begins no gesture and changes nothing; a double click inserts no knot', () => {
    const d = mount();
    const plain = d.knots().find((k) => !k.nested)!;
    const before = d.session.state;
    const count = d.knots().length;
    d.drawer.setEditable(false);
    d.at('pointerdown', plain);
    d.at('pointermove', { x: plain.x + 30, y: plain.y - 30 });
    d.at('pointerup', { x: plain.x + 30, y: plain.y - 30 });
    expect([d.session.inGesture, d.session.state]).toEqual([false, before]);
    d.at('dblclick', { x: (plain.x + d.knots()[1]!.x) / 2, y: 150 });
    expect([d.session.state, d.knots().length]).toEqual([before, count]);
    // On again, the same drag edits the spline.
    d.drawer.setEditable(true);
    d.at('pointerdown', plain);
    d.at('pointermove', { x: plain.x + 30, y: plain.y - 30 });
    d.at('pointerup', { x: plain.x + 30, y: plain.y - 30 });
    expect(d.session.state).not.toBe(before);
  });

  test('a control disabled for its own reason stays disabled after `setEditable(true)`: Reset spline with nothing modified, a nested knot\'s y', () => {
    const d = mount();
    const nested = d.knots().find((k) => k.nested)!;
    d.at('contextmenu', nested, { button: 2 });
    expect([d.button('Reset spline').disabled, d.field('y').disabled, d.field('x').disabled]).toEqual([true, true, false]);
    d.drawer.setEditable(false);
    d.drawer.setEditable(true);
    expect([d.button('Reset spline').disabled, d.field('y').disabled, d.field('x').disabled]).toEqual([true, true, false]);
  });
});

describe('the spline drawer\'s import after the mode was switched off (PAGE-3)', () => {
  test('a file read that resolves after the mode was switched off says it was not imported, never "imported"', async () => {
    let finish: (() => void) | null = null;
    let text = '';
    vi.stubGlobal('FileReader', class {
      result: string | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsText() { finish = () => { this.result = text; this.onload?.(); }; }
    });
    const { session, drawer, by } = mount();
    text = shapeText('shape.offset', session.state.params.shape.offset);
    const input = by('sd-file')[0]!;
    Object.assign(input, { files: [Object.assign(new Blob(['x']), { name: 'offset.wi10-shape.json' })] });
    input.dispatchEvent(new Event('change'));
    expect(finish).not.toBeNull();
    // "Modify terrain" unticked while the file is read.
    session.setWritable(false);
    drawer.setEditable(false);
    finish!();
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(by('sd-message')[0]!.textContent).toBe('offset.wi10-shape.json was not imported: turn on Modify terrain');
  });
});
