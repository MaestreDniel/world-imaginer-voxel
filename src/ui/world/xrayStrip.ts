/**
 * The X-ray's depth band and its strip (SP6a spec §5.3, §7.2; D10, D11).
 *
 * The band is the world y range the X-ray shows its cave walls in: every depth (−64 … 319, `XRAY_ALL`) by default, or a
 * band `yMin` … `yMax`. PageDown and PageUp move it (`bandStep`): from every depth, the first press gives the 32 blocks
 * centred on the camera's y; then the band moves 8 blocks, keeping its width inside the world (ruling P24: the low end
 * clamped to −64 … 320 − width, so a 32-block band stops at [−64, −33] and [288, 319] without shrinking). Home gives
 * `XRAY_ALL`; the Caves tab's sliders give `bandSet` (SP6a spec §7.3). A band is a frozen value: a step returns a new one
 * (a user action, never a frame).
 *
 * The strip `#world-xray-strip` (DOM, beside the build HUD) reads "X-ray · y a … b · by cave type" (the minus sign
 * U+2212, as the spec writes it) above the legend, the nine cave kinds and the surface in the X-ray's colours
 * (`render/xrayPalette.ts`). It shows while the X-ray is on; `set` writes the element only when the state changed, never
 * per frame, and its text only when the band changed. Text only through `textContent`.
 */
import { HEIGHT, MIN_Y } from '../../core/constants';
import { XRAY_COLORS, XRAY_LABELS } from '../../render/xrayPalette';
import { el } from '../common/dom';

/** The X-ray's depth band, world y: `all` (every depth, −64 … 319) or the band `yMin` … `yMax`, both inclusive. */
export interface XrayBand {
  readonly all: boolean;
  readonly yMin: number;
  readonly yMax: number;
}

/** The world's lowest and highest y (−64, 319). */
const WORLD_MIN = MIN_Y;
const WORLD_MAX = MIN_Y + HEIGHT - 1;

/** The band of a first PageDown or PageUp from every depth (SP6a spec §5.3), and each step's move, blocks. */
export const XRAY_BAND_SIZE = 32;
export const XRAY_BAND_STEP = 8;

/** Every depth (the default, and Home). */
export const XRAY_ALL: XrayBand = Object.freeze({ all: true, yMin: WORLD_MIN, yMax: WORLD_MAX });

const band = (yMin: number, yMax: number): XrayBand => Object.freeze({ all: false, yMin, yMax });

/**
 * PageDown (`dir` −1) or PageUp (+1) from `b` with the camera at `cameraY`: from every depth, the 32-block band centred
 * on ⌊cameraY⌋ (`[c − 16, c + 15]`), whatever `dir`; otherwise the band moved 8 by `dir`, its width kept. Either way
 * its low end is clamped to −64 … 320 − width, so it stays whole inside −64 … 319 (ruling P24).
 */
export function bandStep(b: XrayBand, dir: -1 | 1, cameraY: number): XrayBand {
  const width = b.all ? XRAY_BAND_SIZE : b.yMax - b.yMin + 1;
  const low = b.all ? Math.floor(cameraY) - XRAY_BAND_SIZE / 2 : b.yMin + XRAY_BAND_STEP * dir;
  const yMin = Math.min(Math.max(low, WORLD_MIN), WORLD_MAX + 1 - width);
  return band(yMin, yMin + width - 1);
}

/**
 * The band `yMin` … `yMax` as the Caves tab's sliders set it (SP6a spec §7.3; the caller keeps lowest ≤ highest). A
 * RangeError for a band that is not whole blocks inside −64 … 319 with `yMin` ≤ `yMax`.
 */
export function bandSet(yMin: number, yMax: number): XrayBand {
  if (!Number.isInteger(yMin) || !Number.isInteger(yMax) || yMin < WORLD_MIN || yMax > WORLD_MAX || yMin > yMax) {
    throw new RangeError(`the X-ray band ${yMin} … ${yMax} is not whole blocks within ${WORLD_MIN} … ${WORLD_MAX}, lowest first`);
  }
  return band(yMin, yMax);
}

/** A y as the strip writes it: a negative one with the minus sign U+2212. */
const yText = (y: number): string => (y < 0 ? `−${-y}` : String(y));

/** The strip's line (SP6a spec §7.2), also the F3 HUD's while the X-ray is on: "X-ray · y −64 … 319 · by cave type". */
export function stripText(b: XrayBand): string {
  return `X-ray · y ${yText(b.yMin)} … ${yText(b.yMax)} · by cave type`;
}

/** The legend's kinds, in kind order: the nine cave kinds and the surface film (the kinds with a label). */
const LEGEND_KINDS: readonly number[] = XRAY_LABELS.flatMap((label, kind) => (label === '' ? [] : [kind]));

/**
 * Mounts the strip in `host`, hidden (the X-ray is off at a page's start) with every depth's text and the legend.
 * `set(on, b)` shows or hides it and writes the band's text, each only when it changed; `dispose` removes it.
 */
export function createXrayStrip(host: HTMLElement): { set(on: boolean, b: XrayBand): void; dispose(): void } {
  const box = el('div', 'world-xray-strip');
  box.id = 'world-xray-strip';
  box.hidden = true;
  const line = el('div', 'world-xray-line', stripText(XRAY_ALL));
  const legend = el('div', 'world-xray-legend');
  for (const kind of LEGEND_KINDS) {
    const key = el('span', 'world-xray-key');
    const swatch = el('span', 'world-xray-swatch');
    swatch.style.background = XRAY_COLORS[kind]!;
    key.append(swatch, el('span', '', XRAY_LABELS[kind]!));
    legend.append(key);
  }
  box.append(line, legend);
  host.append(box);
  let on = false;
  let all = XRAY_ALL.all;
  let yMin = XRAY_ALL.yMin;
  let yMax = XRAY_ALL.yMax;
  return {
    set(nextOn, b) {
      if (nextOn !== on) {
        on = nextOn;
        box.hidden = !on;
      }
      if (b.all !== all || b.yMin !== yMin || b.yMax !== yMax) {
        all = b.all;
        yMin = b.yMin;
        yMax = b.yMax;
        line.textContent = stripText(b);
      }
    },
    dispose() {
      box.remove();
    },
  };
}
