/**
 * The parameter panel's disposal (SP4c spec §1.2; Task 12 review, minor 1): a slider drag begun on pointerdown installs
 * window pointerup/pointercancel listeners and opens a session gesture; disposing the panel mid-drag (the world's map
 * tool disposed on a fatal error or a context loss) removes both listeners and ends the gesture. And the world-modification
 * mode's cue (SP5b spec D10): `setEditable(false)` disables the panel's value inputs and resets, keeping a rule's reason.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { WorldSession, type ChangeKind } from '../../src/engine/session';
import { validateParamTrees } from '../../src/gen/trees';
import { createTargetRow } from '../../src/ui/paramPanel/controls';
import { createParamPanel } from '../../src/ui/paramPanel/panel';
import { installDom, type FakeElement } from './fixtures/domShim';

/** The window's listeners by type, through `addEventListener`/`removeEventListener` stubbed as globals. */
function stubWindow() {
  const win = new EventTarget();
  const live = new Map<string, number>();
  const count = (type: string, d: number) => live.set(type, (live.get(type) ?? 0) + d);
  vi.stubGlobal('addEventListener', (type: string, fn: EventListener, o?: boolean | AddEventListenerOptions) => {
    count(type, 1);
    win.addEventListener(type, fn, o);
  });
  vi.stubGlobal('removeEventListener', (type: string, fn: EventListener, o?: boolean | EventListenerOptions) => {
    count(type, -1);
    win.removeEventListener(type, fn, o);
  });
  return { win, listeners: (type: string) => live.get(type) ?? 0 };
}

const pointerDown = () => Object.assign(new Event('pointerdown'), { button: 0 });
const sliders = (host: FakeElement) => host.querySelectorAll('input').filter((i) => i.className === 'pp-slider');

describe('the parameter panel disposed mid-drag (Task 12 review, minor 1)', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  test('dispose removes the drag\'s window listeners and ends its gesture (an urgent gestureEnd); a later pointerup does nothing', () => {
    const dom = installDom();
    const win = stubWindow();
    const session = new WorldSession(() => [1, 2], { validateParams: validateParamTrees });
    const host = dom.document.createElement('div');
    const panel = createParamPanel(host as unknown as HTMLElement, {
      session, edit: (_e, fn) => fn(), openSpline: () => {}, showBiomes: () => {}, openTree: () => {},
      sections: { sectionOpen: () => false, setSectionOpen: () => {} },
    });
    const kinds: Array<[ChangeKind, boolean]> = [];
    session.subscribe((_s, c) => kinds.push([c.kind, c.urgent]));
    const slider = sliders(host)[0]!;
    slider.dispatchEvent(pointerDown());
    expect(session.inGesture).toBe(true);
    expect([win.listeners('pointerup'), win.listeners('pointercancel')]).toEqual([1, 1]);

    panel.dispose();
    expect(session.inGesture).toBe(false);
    expect([win.listeners('pointerup'), win.listeners('pointercancel')]).toEqual([0, 0]);
    expect(kinds).toEqual([['gestureBegin', false], ['gestureEnd', true]]);
    // The release after the dispose reaches no listener of the panel.
    win.win.dispatchEvent(new Event('pointerup'));
    expect(kinds).toHaveLength(2);
  });

  test('a drag that ended on its own is not ended again by dispose', () => {
    const dom = installDom();
    const win = stubWindow();
    const session = new WorldSession(() => [1, 2], { validateParams: validateParamTrees });
    const host = dom.document.createElement('div');
    const panel = createParamPanel(host as unknown as HTMLElement, {
      session, edit: (_e, fn) => fn(), openSpline: () => {}, showBiomes: () => {}, openTree: () => {},
      sections: { sectionOpen: () => false, setSectionOpen: () => {} },
    });
    const slider = sliders(host)[0]!;
    slider.dispatchEvent(pointerDown());
    win.win.dispatchEvent(new Event('pointerup'));
    expect(session.inGesture).toBe(false);
    expect(win.listeners('pointerup')).toBe(0);
    // Another editor's gesture is not the panel's to end.
    session.beginGesture();
    panel.dispose();
    expect(session.inGesture).toBe(true);
  });

  test('the Density tab\'s target row hands its open drag to the given registry, whose end removes the listeners and ends the gesture', () => {
    const dom = installDom();
    const win = stubWindow();
    const session = new WorldSession(() => [1, 2], { validateParams: validateParamTrees });
    const drags = new Set<() => void>();
    const row = createTargetRow({ session, edit: (_e, fn) => fn(), drags }, 'density.noises.jag.clampSigma');
    dom.body.append(row.element as unknown as FakeElement);
    sliders(dom.body)[0]!.dispatchEvent(pointerDown());
    expect(drags.size).toBe(1);
    for (const end of [...drags]) end();
    expect(drags.size).toBe(0);
    expect(session.inGesture).toBe(false);
    expect([win.listeners('pointerup'), win.listeners('pointercancel')]).toEqual([0, 0]);
  });
});

describe('the parameter panel in a saved world\'s modification mode (SP5b spec D10, D25)', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  test('`setEditable(false)` disables every value input and section Reset; a control a rule disables stays disabled after `setEditable(true)`', () => {
    const dom = installDom();
    const session = new WorldSession(() => [1, 2], { validateParams: validateParamTrees });
    // A modified leaf: its own reset and its section's Reset are enabled.
    session.set('rivers.widthMin', 6);
    const host = dom.document.createElement('div');
    const panel = createParamPanel(host as unknown as HTMLElement, {
      session, edit: (_e, fn) => fn(), openSpline: () => {}, showBiomes: () => {}, openTree: () => {},
      sections: { sectionOpen: () => false, setSectionOpen: () => {} },
    });
    const values = (): FakeElement[] => [...host.querySelectorAll('input'), ...host.querySelectorAll('select')];
    const buttons = (cls: string) => host.querySelectorAll('button').filter((b) => b.className.split(' ').includes(cls));
    // Disabled by a rule at the mount: a 2D noise's yScale, a density noise's remap.
    const ruled = values().filter((c) => c.disabled);
    expect(ruled.some((c) => c.id.endsWith('.yScale'))).toBe(true);
    expect(ruled.some((c) => c.id.endsWith('.remap'))).toBe(true);
    const enabledResets = [...buttons('pp-section-reset'), ...buttons('pp-reset')].filter((b) => !b.disabled);
    expect(enabledResets.length).toBeGreaterThanOrEqual(2);
    expect(values().length).toBeGreaterThan(ruled.length);

    panel.setEditable(false);
    expect(values().filter((c) => !c.disabled)).toEqual([]);
    expect([...buttons('pp-section-reset'), ...buttons('pp-reset')].filter((b) => !b.disabled)).toEqual([]);
    // Looking stays: the section toggles, a spline's Edit, the Biomes and Density links.
    for (const cls of ['pp-toggle', 'pp-edit', 'pp-link']) {
      expect(buttons(cls).length, cls).toBeGreaterThan(0);
      expect(buttons(cls).every((b) => !b.disabled), cls).toBe(true);
    }
    // A session change while not editable (the panel follows it) keeps every value input and reset disabled.
    session.set('rivers.widthMin', 7);
    expect(values().filter((c) => !c.disabled)).toEqual([]);
    expect([...buttons('pp-section-reset'), ...buttons('pp-reset')].filter((b) => !b.disabled)).toEqual([]);

    panel.setEditable(true);
    expect(values().filter((c) => c.disabled)).toEqual(ruled);
    expect([...buttons('pp-section-reset'), ...buttons('pp-reset')].filter((b) => !b.disabled)).toEqual(enabledResets);
  });
});
