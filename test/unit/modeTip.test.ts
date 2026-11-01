/**
 * The reminder on the map's disabled controls (SP5c spec §7.3, D19): `setModeTip` puts "Enable 'Modify terrain' to edit
 * here" on an element while it is not editable, after the element's own title when it has one, and removes it after:
 * the attribute absent, not empty (an empty title hides every ancestor's).
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { MODE_OFF_TIP, setModeTip } from '../../src/ui/common/modeTip';
import { FakeElement, installDom } from './fixtures/domShim';

afterEach(() => { vi.unstubAllGlobals(); });

describe('setModeTip (SP5c spec §7.3, D19)', () => {
  test('the text', () => {
    expect(MODE_OFF_TIP).toBe("Enable 'Modify terrain' to edit here");
  });

  test('not editable: the title is the tip; editable: the attribute is absent, not empty', () => {
    installDom();
    const e = new FakeElement('div');
    setModeTip(e as unknown as HTMLElement, false);
    expect(e.getAttribute('title')).toBe(MODE_OFF_TIP);
    setModeTip(e as unknown as HTMLElement, true);
    expect(e.getAttribute('title')).toBeNull();
    // Editable from the start: still no attribute.
    const f = new FakeElement('div');
    setModeTip(f as unknown as HTMLElement, true);
    expect(f.getAttribute('title')).toBeNull();
  });

  test('with its own title: the own title then a line with the tip, then the own title back', () => {
    installDom();
    const b = new FakeElement('button');
    b.title = 'Draw a random seed';
    setModeTip(b as unknown as HTMLElement, false, 'Draw a random seed');
    expect(b.getAttribute('title')).toBe(`Draw a random seed\n${MODE_OFF_TIP}`);
    // Twice is the same (each editor calls it on every setEditable and sync).
    setModeTip(b as unknown as HTMLElement, false, 'Draw a random seed');
    expect(b.title).toBe(`Draw a random seed\n${MODE_OFF_TIP}`);
    setModeTip(b as unknown as HTMLElement, true, 'Draw a random seed');
    expect(b.getAttribute('title')).toBe('Draw a random seed');
  });
});

describe('the DOM shim\'s title (SP5c spec §7.3: "absent, not empty")', () => {
  test('`title` reads and writes the attribute: absent until set, \'\' read as the property, removed by removeAttribute', () => {
    const e = new FakeElement('span');
    expect([e.title, e.getAttribute('title')]).toEqual(['', null]);
    e.title = 'a';
    expect(e.getAttribute('title')).toBe('a');
    e.title = '';
    expect(e.getAttribute('title')).toBe('');
    e.setAttribute('title', 'b');
    expect(e.title).toBe('b');
    e.removeAttribute('title');
    expect([e.title, e.getAttribute('title')]).toEqual(['', null]);
  });
});
