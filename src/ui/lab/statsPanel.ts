import { toUniform } from '../../core/noise/cdf';
import { histogram, ksUniform, lastOctaveWavelength, Moments, Rose, samplePoints } from '../../metrics/noiseStats';
import type { Side } from './noiseLab';

const STATS_N = 50000;
const POINTS = samplePoints('lab.stats', STATS_N);
const BUDGET_MS = 8;

export interface StatsPanel {
  update(side: Side | null): void;
  /** Called with the z values over the 50k stats points when a pass finishes. */
  onDone: ((z: Float64Array) => void) | null;
  destroy(): void;
}

function drawHistogram(canvas: HTMLCanvasElement, counts: Uint32Array, lo: number, hi: number, uniform: boolean): void {
  const ctx = canvas.getContext('2d');
  if (ctx === null) return;
  const w = (canvas.width = canvas.clientWidth || 300);
  const h = (canvas.height = canvas.clientHeight || 120);
  ctx.clearRect(0, 0, w, h);
  const total = counts.reduce((s, c) => s + c, 0);
  const bins = counts.length;
  const width = (hi - lo) / bins;
  const pdf = (x: number) => (uniform ? 0.5 : Math.exp(-(x * x) / 2) / Math.sqrt(2 * Math.PI));
  let peak = 0;
  for (let i = 0; i < bins; i++) peak = Math.max(peak, counts[i]! / (total * width), pdf(lo + (i + 0.5) * width));
  ctx.fillStyle = '#5b8def';
  for (let i = 0; i < bins; i++) {
    const d = counts[i]! / (total * width);
    const bh = (d / peak) * (h - 4);
    ctx.fillRect((i * w) / bins, h - bh, w / bins - 1, bh);
  }
  ctx.strokeStyle = '#f0b34a';
  ctx.beginPath();
  for (let i = 0; i <= 100; i++) {
    const x = lo + ((hi - lo) * i) / 100;
    const y = h - (pdf(x) / peak) * (h - 4);
    if (i === 0) ctx.moveTo((i * w) / 100, y); else ctx.lineTo((i * w) / 100, y);
  }
  ctx.stroke();
}

function drawRose(canvas: HTMLCanvasElement, rose: Rose): void {
  const ctx = canvas.getContext('2d');
  if (ctx === null) return;
  const w = (canvas.width = canvas.clientWidth || 300);
  const h = (canvas.height = canvas.clientHeight || 120);
  ctx.clearRect(0, 0, w, h);
  const max = Math.max(...rose.counts);
  const r0 = Math.min(w, h) / 2 - 4;
  ctx.fillStyle = '#7ee787';
  for (let b = 0; b < 16; b++) {
    const theta = (b / 16) * 2 * Math.PI - Math.PI;
    const r = max > 0 ? (rose.counts[b]! / max) * r0 : 0;
    ctx.beginPath();
    ctx.moveTo(w / 2, h / 2);
    ctx.arc(w / 2, h / 2, r, theta - Math.PI / 16, theta + Math.PI / 16);
    ctx.closePath();
    ctx.fill();
  }
}

/** Statistics over 50k random points of the whole window (not the visible pixels), computed in ≤ 8 ms slices. */
export function createStatsPanel(host: HTMLElement, title: string): StatsPanel {
  const box = document.createElement('div');
  box.className = 'lab-stats';
  const h = document.createElement('h3');
  h.textContent = title;
  const text = document.createElement('pre');
  const hist = document.createElement('canvas');
  const roseCanvas = document.createElement('canvas');
  box.append(h, text, hist, roseCanvas);
  host.append(box);
  let generation = 0;
  let raf = 0;
  const panel: StatsPanel = {
    onDone: null,
    update(side) {
      generation++;
      cancelAnimationFrame(raf);
      if (side === null) { text.textContent = ''; return; }
      const gen = generation;
      const z = new Float64Array(STATS_N);
      const m = new Moments();
      const rose = new Rose();
      const c = side.nn.clamp;
      const step = lastOctaveWavelength(side.noise.def) / 128;
      const f = side.noise.dims === 2 ? (x: number, _y: number, zz: number) => side.nn.z2(x, zz) : (x: number, y: number, zz: number) => side.nn.z3(x, y, zz);
      let atClamp = 0;
      let i = 0;
      const tick = () => {
        if (gen !== generation) return;
        const t0 = performance.now();
        while (i < STATS_N && performance.now() - t0 < BUDGET_MS) {
          for (let k = 0; k < 256 && i < STATS_N; k++, i++) {
            const x = POINTS.x[i]!, y = POINTS.y[i]!, zz = POINTS.z[i]!;
            const v = f(x, y, zz);
            z[i] = v;
            m.add(v);
            if (Math.abs(v) === c) atClamp++;
            const xp = f(x + step, y, zz), xm = f(x - step, y, zz), zp = f(x, y, zz + step), zm = f(x, y, zz - step);
            if (Math.abs(xp) !== c && Math.abs(xm) !== c && Math.abs(zp) !== c && Math.abs(zm) !== c) rose.add(xp - xm, zp - zm);
          }
        }
        text.textContent = `${i < STATS_N ? `computing ${Math.round((100 * i) / STATS_N)} %` : 'done'}\n`;
        if (i < STATS_N) { raf = requestAnimationFrame(tick); return; }
        const u = z.map((v) => toUniform(v));
        const uniform = side.noise.def.remap === 'uniform';
        text.textContent = [
          `n ${STATS_N}  mean ${m.mean.toFixed(4)}  sd ${m.sd.toFixed(4)}`,
          `min ${m.min.toFixed(3)}  max ${m.max.toFixed(3)}  at clamp ${((100 * atClamp) / STATS_N).toFixed(3)} %`,
          `KS D of u vs U(-1, 1): ${ksUniform(u).toFixed(4)}`,
          `gradient rose max/min: ${rose.ratio().toFixed(3)}`,
        ].join('\n');
        drawHistogram(hist, uniform ? histogram(u, -1, 1, 64) : histogram(z, -c, c, 64), uniform ? -1 : -c, uniform ? 1 : c, uniform);
        drawRose(roseCanvas, rose);
        panel.onDone?.(z);
      };
      raf = requestAnimationFrame(tick);
    },
    destroy() { generation++; cancelAnimationFrame(raf); box.remove(); },
  };
  return panel;
}
