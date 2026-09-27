import { WINDOW } from '../../metrics/noiseStats';
import { MAX_BPP, MIN_BPP } from './labState';

export interface Camera {
  readonly x: number;
  readonly z: number;
  readonly bpp: number;
}

/** Value at world coordinates (horizontal a, vertical b of the view plane). */
export type Sample = (a: number, b: number) => number;

export interface FieldViewOptions {
  onCamera(cam: Camera): void;
  onHover(a: number, b: number, value: number): void;
}

export interface FieldView {
  readonly canvas: HTMLCanvasElement;
  setSource(sample: Sample, lo: number, hi: number): void;
  setCamera(cam: Camera): void;
  destroy(): void;
}

const LEVELS = [8, 2, 1];
const BUDGET_MS = 8;

/** Diverging colour map (coolwarm): t ∈ [0, 1] → RGB. */
function colour(t: number, out: Uint8ClampedArray, o: number): void {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  const [r0, g0, b0, r1, g1, b1, s] = c < 0.5 ? [59, 76, 192, 221, 221, 221, c * 2] : [221, 221, 221, 180, 4, 38, c * 2 - 1];
  out[o] = r0 + (r1 - r0) * s;
  out[o + 1] = g0 + (g1 - g0) * s;
  out[o + 2] = b0 + (b1 - b0) * s;
  out[o + 3] = 255;
}

const clampCenter = (v: number) => Math.max(-WINDOW, Math.min(WINDOW, v));

/**
 * 2D canvas (backing store = CSS size, DPR 1) rendering a field coarse to fine (1/8, 1/2, full) in
 * ≤ 8 ms slices per frame; any change restarts the pass. Drag pans, wheel zooms around the cursor.
 */
export function createFieldView(host: HTMLElement, opts: FieldViewOptions): FieldView {
  const canvas = document.createElement('canvas');
  canvas.className = 'lab-canvas';
  host.append(canvas);
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('2D canvas unavailable');
  let cam: Camera = { x: 0, z: 0, bpp: 64 };
  let sample: Sample = () => 0;
  let lo = -1;
  let hi = 1;
  let generation = 0;
  let raf = 0;
  let image = ctx.createImageData(1, 1);

  const worldAt = (px: number, py: number): [number, number] => [
    cam.x + (px + 0.5 - canvas.width / 2) * cam.bpp,
    cam.z + (py + 0.5 - canvas.height / 2) * cam.bpp,
  ];

  const restart = () => {
    generation++;
    cancelAnimationFrame(raf);
    const gen = generation;
    const w = canvas.width;
    const h = canvas.height;
    if (w === 0 || h === 0) return;
    if (image.width !== w || image.height !== h) image = ctx.createImageData(w, h);
    let level = 0;
    let row = 0;
    const step = () => {
      if (gen !== generation) return;
      const t0 = performance.now();
      while (level < LEVELS.length && performance.now() - t0 < BUDGET_MS) {
        const s = LEVELS[level]!;
        for (let bx = 0; bx < w; bx += s) {
          const [a, b] = worldAt(bx + s / 2 - 0.5, row + s / 2 - 0.5);
          const v = sample(a, b);
          const t = (v - lo) / (hi - lo);
          for (let yy = row; yy < Math.min(row + s, h); yy++) {
            for (let xx = bx; xx < Math.min(bx + s, w); xx++) colour(t, image.data, (yy * w + xx) * 4);
          }
        }
        row += s;
        if (row >= h) { row = 0; level++; ctx.putImageData(image, 0, 0); }
      }
      ctx.putImageData(image, 0, 0);
      if (level < LEVELS.length) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  };

  const resize = () => {
    const w = Math.max(1, Math.floor(host.clientWidth));
    const h = Math.max(1, Math.floor(host.clientHeight));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; restart(); }
  };
  const observer = new ResizeObserver(resize);
  observer.observe(host);

  let drag: { x: number; y: number } | null = null;
  canvas.addEventListener('pointerdown', (e) => { drag = { x: e.offsetX, y: e.offsetY }; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointerup', () => { drag = null; });
  canvas.addEventListener('pointermove', (e) => {
    const [a, b] = worldAt(e.offsetX, e.offsetY);
    opts.onHover(a, b, sample(a, b));
    if (drag === null) return;
    const dx = e.offsetX - drag.x;
    const dy = e.offsetY - drag.y;
    drag = { x: e.offsetX, y: e.offsetY };
    opts.onCamera({ x: clampCenter(cam.x - dx * cam.bpp), z: clampCenter(cam.z - dy * cam.bpp), bpp: cam.bpp });
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const [a, b] = worldAt(e.offsetX, e.offsetY);
    const bpp = Math.max(MIN_BPP, Math.min(MAX_BPP, cam.bpp * (e.deltaY > 0 ? 1.25 : 0.8)));
    const k = bpp / cam.bpp;
    opts.onCamera({ x: clampCenter(a - (a - cam.x) * k), z: clampCenter(b - (b - cam.z) * k), bpp });
  }, { passive: false });

  resize();
  return {
    canvas,
    setSource(s, l, h) { sample = s; lo = l; hi = h; restart(); },
    setCamera(c) { cam = c; restart(); },
    destroy() { generation++; cancelAnimationFrame(raf); observer.disconnect(); canvas.remove(); },
  };
}
