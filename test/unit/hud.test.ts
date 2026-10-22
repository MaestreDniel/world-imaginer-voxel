import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { OPENING_T } from '../../src/daynight/dayNight';
import { formatClock, mountWorldHud, timeSpeedLabel, type HudData } from '../../src/ui/hud';
import { installDom } from './fixtures/domShim';

const DATA: HudData = {
  frame: { fps: 60, p50: 16.7, p95: 17.2, count: 120 },
  columns: { t: 825, d: 705, l: 593, meshed: 489 },
  sections: 3512,
  drawCalls: 640,
  triangles: 1_420_000,
  position: { x: 12.3, y: 80, z: -40.5 },
  speed: 12,
  time: OPENING_T,
  timeSpeed: 10,
  rd: 12,
  workers: 6,
  sectionRenderer: 'batch',
  renderer: 'ANGLE (Intel, Mesa Intel(R) Xe Graphics (TGL GT2), OpenGL 4.6)',
};

describe('formatClock and timeSpeedLabel (SP4a spec §6.5, §6.9)', () => {
  test('t 0 is sunrise at 06:00, the opening is 08:00, t 0.5 is 18:00, t 0.75 is midnight', () => {
    expect(formatClock(0)).toBe('06:00');
    expect(formatClock(OPENING_T)).toBe('08:00');
    expect(formatClock(0.5)).toBe('18:00');
    expect(formatClock(0.75)).toBe('00:00');
    expect(formatClock(0.999999)).toBe('05:59');
  });

  test('×1, ×10, ×60 and paused', () => {
    expect([1, 10, 60, 0].map(timeSpeedLabel)).toEqual(['×1', '×10', '×60', 'paused']);
  });
});

describe('mountWorldHud (SP4a spec §6.9, D30)', () => {
  let dom: ReturnType<typeof installDom>;
  beforeEach(() => {
    dom = installDom();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  const mount = (read: () => HudData) => mountWorldHud(dom.body as unknown as HTMLElement, read);

  test('the text names the section renderer, the clock 08:00 and ×10, and the counts', () => {
    mount(() => DATA);
    const text = dom.body.textContent;
    expect(text).toContain('batch');
    expect(text).toContain('08:00');
    expect(text).toContain('×10');
    for (const part of ['T 825', 'D 705', 'L 593', 'meshed 489', 'sections 3512', 'draw calls 640', 'triangles 1.42 M']) {
      expect(text).toContain(part);
    }
    expect(text).toContain('60 fps · p50 16.7 ms · p95 17.2 ms');
    expect(text).toContain('RD 12');
    expect(text).toContain('6 workers');
    expect(text).toContain('12.0 blocks/s');
    expect(text).toContain('Mesa Intel(R) Xe Graphics');
  });

  test('position and column; mesh, paused and an unreported renderer string', () => {
    mount(() => ({ ...DATA, position: { x: -0.5, y: 64.25, z: 31.9 }, sectionRenderer: 'mesh', timeSpeed: 0, renderer: null }));
    const text = dom.body.textContent;
    expect(text).toContain('x -0.5 y 64.3 z 31.9');
    expect(text).toContain('column -1, 1');
    expect(text).toContain('mesh');
    expect(text).toContain('paused');
    expect(text).toContain('not reported');
  });

  test('the key hints come from the key map', () => {
    mount(() => DATA);
    expect(dom.body.textContent).toContain('F3');
    expect(dom.body.textContent).toContain('H / F1');
  });

  test('it updates every 250 ms', () => {
    let speed = 12;
    const read = vi.fn(() => ({ ...DATA, speed }));
    mount(read);
    expect(read).toHaveBeenCalledTimes(1);
    speed = 48;
    vi.advanceTimersByTime(249);
    expect(read).toHaveBeenCalledTimes(1);
    expect(dom.body.textContent).toContain('12.0 blocks/s');
    vi.advanceTimersByTime(1);
    expect(read).toHaveBeenCalledTimes(2);
    expect(dom.body.textContent).toContain('48.0 blocks/s');
  });

  test('toggle hides and shows it (no reads while hidden); dispose removes it and stops the updates', () => {
    const read = vi.fn(() => DATA);
    const hud = mount(read);
    const box = dom.body.children[0]!;
    hud.toggle();
    expect(box.hidden).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(read).toHaveBeenCalledTimes(1);
    hud.toggle();
    expect(box.hidden).toBe(false);
    expect(read).toHaveBeenCalledTimes(2);
    hud.dispose();
    expect(dom.body.children).toEqual([]);
    vi.advanceTimersByTime(1000);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
