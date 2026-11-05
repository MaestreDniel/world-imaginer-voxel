/**
 * The X-ray's depth band and its strip (SP6a spec §5.3, §7.2; D11; Review Focus 3; ruling P24).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { CAVE_FILM_KIND, CAVE_KIND } from '../../src/core/constants';
import { XRAY_COLORS, XRAY_LABELS } from '../../src/render/xrayPalette';
import { bandSet, bandStep, createXrayStrip, stripText, XRAY_ALL, type XrayBand } from '../../src/ui/world/xrayStrip';
import { installDom } from './fixtures/domShim';

const of = (b: XrayBand): [number, number] => [b.yMin, b.yMax];
const steps = (b: XrayBand, dir: -1 | 1, n: number, cameraY = 80.5): XrayBand => {
  let out = b;
  for (let i = 0; i < n; i++) out = bandStep(out, dir, cameraY);
  return out;
};

describe('the X-ray band (SP6a spec §5.3, D11; Review Focus 3)', () => {
  test('from all with the camera at y 400, PageDown gives [288, 319]; at y −80 it gives [−64, −33]; ten PageDowns from [−40, −9] end at [−64, −33] (32 blocks); ten PageUps from [216, 247] end at [288, 319] (clamped, 32 blocks); Home gives all and the strip reads `X-ray · y −64 … 319 · by cave type`', () => {
    expect(of(bandStep(XRAY_ALL, -1, 400))).toEqual([288, 319]);
    expect(of(bandStep(XRAY_ALL, -1, -80))).toEqual([-64, -33]);
    const down = steps(bandSet(-40, -9), -1, 10);
    expect(of(down)).toEqual([-64, -33]);
    expect(down.yMax - down.yMin + 1).toBe(32);
    const up = steps(bandSet(216, 247), 1, 10);
    expect(of(up)).toEqual([288, 319]);
    expect(up.yMax - up.yMin + 1).toBe(32);
    // Home.
    expect(XRAY_ALL).toEqual({ all: true, yMin: -64, yMax: 319 });
    expect(stripText(XRAY_ALL)).toBe('X-ray · y −64 … 319 · by cave type');
  });

  test('from all, the first press is the 32 blocks centred on ⌊cameraY⌋ whatever its direction; then each press moves the band 8', () => {
    for (const dir of [-1, 1] as const) {
      const b = bandStep(XRAY_ALL, dir, 80.9);
      expect([b.all, ...of(b)]).toEqual([false, 64, 95]);
    }
    expect(of(bandStep(bandSet(64, 95), -1, 80.9))).toEqual([56, 87]);
    expect(of(bandStep(bandSet(64, 95), 1, 80.9))).toEqual([72, 103]);
    // A negative camera y floors down: ⌊−20.5⌋ = −21.
    expect(of(bandStep(XRAY_ALL, 1, -20.5))).toEqual([-37, -6]);
    // The camera's y does not move a band that is not all.
    expect(of(bandStep(bandSet(64, 95), -1, 300))).toEqual([56, 87]);
  });

  test('a wider band keeps its width and stops whole at both ends (ruling P24): [100, 315] PageUp gives [104, 319], PageDown [92, 307]; held at the ends it stays', () => {
    expect(of(bandStep(bandSet(100, 315), 1, 0))).toEqual([104, 319]);
    expect(of(bandStep(bandSet(100, 315), -1, 0))).toEqual([92, 307]);
    expect(of(steps(bandSet(100, 315), 1, 5))).toEqual([104, 319]);
    expect(of(steps(bandSet(-60, 100), -1, 5))).toEqual([-64, 96]);
    // The whole world as a band (not all): it cannot move.
    expect(of(bandStep(bandSet(-64, 319), 1, 0))).toEqual([-64, 319]);
  });

  test('bands are frozen values; a step returns a new one', () => {
    const b = bandSet(0, 31);
    expect(Object.isFrozen(b)).toBe(true);
    expect(Object.isFrozen(XRAY_ALL)).toBe(true);
    const next = bandStep(b, 1, 0);
    expect(next).not.toBe(b);
    expect(b).toEqual({ all: false, yMin: 0, yMax: 31 });
  });

  test('bandSet takes whole blocks inside −64 … 319, lowest first; anything else is a RangeError', () => {
    expect(bandSet(-64, 319)).toEqual({ all: false, yMin: -64, yMax: 319 });
    expect(bandSet(7, 7)).toEqual({ all: false, yMin: 7, yMax: 7 });
    for (const [a, b] of [[10, 9], [-65, 0], [0, 320], [0.5, 10], [0, Number.NaN]] as const) {
      expect(() => bandSet(a, b), `${a} … ${b}`).toThrow(RangeError);
    }
  });

  test('the strip of [−40, −9] reads `X-ray · y −40 … −9 · by cave type`; of [12, 43] `X-ray · y 12 … 43 · by cave type`', () => {
    expect(stripText(bandSet(-40, -9))).toBe('X-ray · y −40 … −9 · by cave type');
    expect(stripText(bandSet(12, 43))).toBe('X-ray · y 12 … 43 · by cave type');
    expect(stripText(bandSet(-64, 319))).toBe(stripText(XRAY_ALL));
  });
});

describe('the strip #world-xray-strip (SP6a spec §7.2)', () => {
  let dom: ReturnType<typeof installDom>;
  beforeEach(() => { dom = installDom(); });
  afterEach(() => { vi.unstubAllGlobals(); });
  const mount = () => createXrayStrip(dom.body as unknown as HTMLElement);

  test('mounted hidden with every depth\'s line; the legend lists the nine kinds and the surface, each in the X-ray\'s colour', () => {
    mount();
    const box = dom.el('world-xray-strip');
    expect(box.hidden).toBe(true);
    const [line, legend] = box.children;
    expect(line!.textContent).toBe('X-ray · y −64 … 319 · by cave type');
    const kinds = [
      CAVE_KIND.cheese, CAVE_KIND.spaghetti3d, CAVE_KIND.spaghetti2d, CAVE_KIND.noodle, CAVE_KIND.entrance, CAVE_KIND.worm,
      CAVE_KIND.ravine, CAVE_KIND.undergroundWorm, CAVE_KIND.other, CAVE_FILM_KIND,
    ];
    expect(legend!.children.map((k) => k.textContent)).toEqual(kinds.map((k) => XRAY_LABELS[k]));
    expect(legend!.children.map((k) => k.textContent)).toEqual([
      'Cheese', 'Spaghetti 3D', 'Spaghetti 2D', 'Noodle', 'Entrance', 'Worm', 'Ravine', 'Underground worm', 'Other density air', 'Surface',
    ]);
    expect(legend!.children.map((k) => k.children[0]!.style['background'])).toEqual(kinds.map((k) => XRAY_COLORS[k]));
  });

  test('set shows it on and hides it off; the line names the band; each written only when it changed (never per frame)', () => {
    const strip = mount();
    const box = dom.el('world-xray-strip');
    const line = box.children[0]!;
    const textNode = line.childNodes[0];
    // Off at every depth: nothing changed, nothing written.
    strip.set(false, XRAY_ALL);
    expect([box.hidden, line.childNodes[0]]).toEqual([true, textNode]);
    strip.set(true, XRAY_ALL);
    expect(box.hidden).toBe(false);
    expect(line.childNodes[0]).toBe(textNode);
    const b = bandSet(-40, -9);
    strip.set(true, b);
    expect(line.textContent).toBe('X-ray · y −40 … −9 · by cave type');
    const moved = line.childNodes[0];
    expect(moved).not.toBe(textNode);
    // The same band again (an equal value too): the text node is kept.
    strip.set(true, b);
    strip.set(true, bandSet(-40, -9));
    expect(line.childNodes[0]).toBe(moved);
    // Off keeps the band's text for the next on.
    strip.set(false, b);
    expect([box.hidden, line.childNodes[0]]).toEqual([true, moved]);
    strip.set(true, XRAY_ALL);
    expect([box.hidden, line.textContent]).toEqual([false, 'X-ray · y −64 … 319 · by cave type']);
  });

  test('dispose removes it', () => {
    const strip = mount();
    strip.dispose();
    expect(dom.body.querySelector('#world-xray-strip')).toBeNull();
  });
});
