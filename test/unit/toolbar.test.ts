import { afterEach, describe, expect, test, vi } from 'vitest';
import { WorldSession as RealSession } from '../../src/engine/session';
import type { WorldSession } from '../../src/engine/session';
import { validateParamTrees } from '../../src/gen/trees';
import type { Notices } from '../../src/ui/common/notice';
import { BIOME_SIZE_SCALE } from '../../src/ui/map/biomeSize';
import type { DriverStatus } from '../../src/ui/map/previewDriver';
import { biomeSizeView, createToolbar, previewStatusText, profileOptions, profileSwitchText, type ToolbarDeps } from '../../src/ui/map/toolbar';
import { installDom, type FakeDocument, type FakeElement } from './fixtures/domShim';

const status = (s: Partial<DriverStatus>): DriverStatus => ({ lastLatencyMs: null, pending: false, queued: false, settled: false, poolEpoch: null, sessionEpoch: null, error: null, ...s });

describe('toolbar texts (SP2b spec §2.6, §3.1, §6.4)', () => {
  test('the preview status reads "last edit → preview N ms", with the pending state and the error', () => {
    expect(previewStatusText(status({ pending: true }))).toBe('last edit → preview … · pending');
    expect(previewStatusText(status({ lastLatencyMs: 87.4, settled: true, poolEpoch: 3 }))).toBe('last edit → preview 87 ms');
    expect(previewStatusText(status({ lastLatencyMs: 87.5, pending: true }))).toBe('last edit → preview 88 ms · pending');
    expect(previewStatusText(status({ lastLatencyMs: 120, error: 'BAD_PARAMS: x' }))).toBe('last edit → preview 120 ms · error: BAD_PARAMS: x');
  });

  test('the profile switch confirmation counts the modified parameters', () => {
    expect(profileSwitchText('large_biomes', 1)).toBe('Switching to large_biomes clears 1 modified parameter');
    expect(profileSwitchText('default', 3)).toBe('Switching to default clears 3 modified parameters');
  });

  test('the profile select lists the ready profiles in PROFILE_IDS order: every one but cave_heavy from SP3e (SP3e spec §11)', () => {
    expect(profileOptions()).toEqual(['default', 'large_biomes', 'archipelago', 'amplified', 'floating_islands']);
  });

  test('every table value shows its own position without "≈"', () => {
    BIOME_SIZE_SCALE.forEach((scaleMul, i) => {
      const b = biomeSizeView(scaleMul);
      expect([b.v, b.mark]).toEqual([i + 1, '']);
      expect(b.tip).toBe(`Biome size ${i + 1} of 10 (climate.scaleMul ${scaleMul})`);
    });
  });

  test('a value off the table shows the nearest position with "≈" and the exact value in the tooltip', () => {
    for (const [scaleMul, v] of [[2, 8], [2.01, 8], [0.25, 1], [16, 10]] as const) {
      const b = biomeSizeView(scaleMul);
      expect([b.v, b.mark]).toEqual([v, '≈']);
      expect(b.tip).toBe(`Biome size ≈ ${v} of 10: climate.scaleMul is ${scaleMul}; moving the slider writes the table value`);
    }
  });
});

describe('the toolbar in the world (SP4c spec §2.5, D17, D26)', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  /** The members of the session and the notices `createToolbar` reads at mount. */
  const session = {
    state: { seedText: '42', profile: 'default', params: { climate: { scaleMul: 1 } } },
    canUndo: false,
    canRedo: false,
  } as unknown as WorldSession;
  const notices = {} as unknown as Notices;
  const mount = (document: FakeDocument, embedded: ToolbarDeps['embedded']): FakeElement => {
    const host = document.createElement('div');
    createToolbar(host as unknown as HTMLElement, {
      session, notices, layer: 'biome', edit: (_e, fn) => fn(),
      onLayer: () => {}, onGrid: () => {}, onCut: () => {}, open3dHref: () => '/?at=0,0',
      embedded,
    });
    return host;
  };
  const texts = (host: FakeElement): string[] => host.children.map((c) => c.textContent);

  test('standalone: Open in 3D, no hint', () => {
    const host = mount(installDom().document, null);
    expect(texts(host)).toContain('Open in 3D');
    expect(texts(host).some((t) => t.includes('Shift+click'))).toBe(false);
  });

  test('embedded: no Open in 3D, the hint `Click: go here · Shift+click: pin`, the slot appended after the hint', () => {
    const { document } = installDom();
    const slot = document.createElement('div');
    slot.append(document.createElement('button'));
    const host = mount(document, { slot: slot as unknown as HTMLElement, hint: 'Click: go here · Shift+click: pin' });
    expect(host.querySelectorAll('button').some((b) => b.textContent === 'Open in 3D')).toBe(false);
    const kids = host.children;
    expect(kids[kids.length - 1]).toBe(slot);
    expect(kids[kids.length - 2]!.textContent).toBe('Click: go here · Shift+click: pin');
    expect(kids.filter((k) => k.textContent === 'Click: go here · Shift+click: pin')).toHaveLength(1);
  });

  test('`setEditable(false)` disables the seed, Same seed, New seed, the preset, the biome size, Undo and Redo; the layer, grid and cut-line controls stay enabled (SP5b spec D10)', () => {
    const { document } = installDom();
    const host = document.createElement('div');
    // A session with a step to undo and one to redo: its Undo and Redo are enabled for that reason.
    const withSteps = { ...session, canUndo: true, canRedo: true } as unknown as WorldSession;
    const toolbar = createToolbar(host as unknown as HTMLElement, {
      session: withSteps, notices, layer: 'biome', edit: (_e, fn) => fn(),
      onLayer: () => {}, onGrid: () => {}, onCut: () => {}, open3dHref: () => '/?at=0,0',
      embedded: { slot: document.createElement('span') as unknown as HTMLElement, hint: 'Click: go here · Shift+click: pin' },
    });
    const inputs = host.querySelectorAll('input');
    const selects = host.querySelectorAll('select');
    const buttons = host.querySelectorAll('button');
    const byText = (t: string) => buttons.find((b) => b.textContent === t)!;
    const terrain = [
      inputs.find((i) => i.type === 'text')!, byText('Same seed'), byText('New seed'), selects.find((s) => s.title === 'Profile')!,
      inputs.find((i) => i.type === 'range')!, byText('Undo'), byText('Redo'),
    ];
    const looking = [selects.find((s) => s.title === 'Map layer')!, inputs.find((i) => i.type === 'checkbox')!, buttons.find((b) => b.className === 'map-cut')!];
    expect([...terrain, ...looking].every((c) => c !== undefined && !c.disabled)).toBe(true);
    toolbar.setEditable(false);
    expect(terrain.map((c) => c.disabled)).toEqual([true, true, true, true, true, true, true]);
    expect(looking.map((c) => c.disabled)).toEqual([false, false, false]);
    // A sync (every session change) keeps Undo and Redo disabled while not editable.
    toolbar.sync();
    expect([byText('Undo').disabled, byText('Redo').disabled]).toEqual([true, true]);
    toolbar.setEditable(true);
    expect(terrain.map((c) => c.disabled)).toEqual([false, false, false, false, false, false, false]);
  });

  test('a profile switch confirmed after the mode was switched off changes nothing and shows no "profile switched" with its Undo (PAGE-3)', async () => {
    const { document } = installDom();
    const host = document.createElement('div');
    const real = new RealSession(() => [1, 2], { seedText: '42', validateParams: validateParamTrees });
    real.set('climate.scaleMul', 2);
    real.set('climate.scaleMul', 3);
    let answer: ((ok: boolean) => void) | null = null;
    const shown: string[] = [];
    const confirmer = {
      confirm: () => new Promise<boolean>((resolve) => { answer = resolve; }),
      show: (text: string) => { shown.push(text); },
    } as unknown as Notices;
    const toolbar = createToolbar(host as unknown as HTMLElement, {
      session: real, notices: confirmer, layer: 'biome', edit: (_e, fn) => fn(),
      onLayer: () => {}, onGrid: () => {}, onCut: () => {}, open3dHref: () => '/?at=0,0',
      embedded: { slot: document.createElement('span') as unknown as HTMLElement, hint: 'Click: go here · Shift+click: pin' },
    });
    const select = host.querySelectorAll('select').find((x) => x.title === 'Profile')!;
    const other = profileOptions().find((p) => p !== real.state.profile)!;
    select.value = other;
    select.dispatchEvent(new Event('change'));
    expect(answer).not.toBeNull();
    // "Modify terrain" unticked while the confirmation is open: the session refuses, then the editors are disabled.
    real.setWritable(false);
    toolbar.setEditable(false);
    answer!(true);
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect([real.state.profile, real.state.params.climate.scaleMul, shown]).toEqual(['default', 3, []]);
  });

  test('a control disabled for its own reason stays disabled after `setEditable(true)`: Undo and Redo with no step', () => {
    const { document } = installDom();
    const host = document.createElement('div');
    const toolbar = createToolbar(host as unknown as HTMLElement, {
      session, notices, layer: 'biome', edit: (_e, fn) => fn(),
      onLayer: () => {}, onGrid: () => {}, onCut: () => {}, open3dHref: () => '/?at=0,0', embedded: null,
    });
    const buttons = host.querySelectorAll('button');
    toolbar.setEditable(false);
    toolbar.setEditable(true);
    expect(['Undo', 'Redo', 'New seed'].map((t) => buttons.find((b) => b.textContent === t)!.disabled)).toEqual([true, true, false]);
  });
});
