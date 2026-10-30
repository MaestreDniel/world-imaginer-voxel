/**
 * The Presets tab's DOM in a saved world's modification mode (SP5b spec D10, D25), on the DOM shim with a real session:
 * `setEditable(false)` disables the import and the JSON patch box with its Apply; Export (the name field and its button)
 * stays. A control disabled for its own reason (Apply with the draft's patch shown, Export with no name) stays disabled
 * when the mode is on again.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { WorldSession } from '../../src/engine/session';
import { validateParamTrees } from '../../src/gen/trees';
import type { Notices } from '../../src/ui/common/notice';
import { createPresetsTab } from '../../src/ui/presets/presetsTab';
import { installDom } from './fixtures/domShim';

afterEach(() => { vi.unstubAllGlobals(); });

function mount() {
  const dom = installDom();
  const session = new WorldSession(() => [1, 2], { validateParams: validateParamTrees });
  const host = dom.document.createElement('div');
  dom.body.append(host);
  const tab = createPresetsTab(host as unknown as HTMLElement, { session, notices: { show: () => {} } as unknown as Notices, edit: (_e, fn) => fn() });
  return { session, tab, el: dom.el };
}

describe('the Presets tab\'s setEditable (SP5b spec D10)', () => {
  test('false disables Import, the file input, the patch box and Apply; the name and Export stay; true enables them again', () => {
    const { tab, el } = mount();
    const name = el('pt-name');
    name.value = 'mine';
    name.dispatchEvent(new Event('input'));
    const box = el('pt-patch');
    box.value = '{"rivers": {"widthMin": 6}}';
    box.dispatchEvent(new Event('input'));
    const edits = ['pt-import', 'pt-file', 'pt-patch', 'pt-apply'];
    expect(edits.map((id) => el(id).disabled)).toEqual([false, false, false, false]);
    expect([el('pt-name').disabled, el('pt-export').disabled]).toEqual([false, false]);

    tab.setEditable(false);
    expect(edits.map((id) => el(id).disabled)).toEqual([true, true, true, true]);
    expect([el('pt-name').disabled, el('pt-export').disabled]).toEqual([false, false]);
    // Typing in the box (a paste before it was disabled) leaves Apply disabled.
    box.dispatchEvent(new Event('input'));
    expect(el('pt-apply').disabled).toBe(true);

    tab.setEditable(true);
    expect(edits.map((id) => el(id).disabled)).toEqual([false, false, false, false]);
  });

  test('a control disabled for its own reason stays disabled after `setEditable(true)`: Apply with the draft\'s patch shown, Export with no name', () => {
    const { tab, el } = mount();
    expect([el('pt-apply').disabled, el('pt-export').disabled]).toEqual([true, true]);
    tab.setEditable(false);
    tab.setEditable(true);
    expect([el('pt-apply').disabled, el('pt-export').disabled, el('pt-import').disabled, el('pt-patch').disabled]).toEqual([true, true, false, false]);
  });
});
