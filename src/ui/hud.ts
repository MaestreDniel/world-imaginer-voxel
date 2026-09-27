import type { FrameStats } from './frameStats';

const REFRESH_MS = 250;

export function mountHud(host: HTMLElement, stats: FrameStats): () => void {
  const span = document.createElement('span');
  span.className = 'hud';
  host.append(span);
  const id = setInterval(() => {
    const s = stats.summary();
    span.textContent = `${s.fps.toFixed(0)} fps · p50 ${s.p50.toFixed(1)} ms · p95 ${s.p95.toFixed(1)} ms`;
  }, REFRESH_MS);
  return () => clearInterval(id);
}
