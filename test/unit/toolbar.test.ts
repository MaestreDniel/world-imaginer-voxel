import { afterEach, describe, expect, test, vi } from 'vitest';
import type { WorldSession } from '../../src/engine/session';
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
});
