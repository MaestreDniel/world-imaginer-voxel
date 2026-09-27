import { Color, SRGBColorSpace, WebGLRenderer } from 'three';

const SKY = 0x87b8e8;

export interface SkyRenderer {
  dispose(): void;
}

export function startSkyRenderer(host: HTMLElement, onFrame: (frameMs: number) => void): SkyRenderer {
  const renderer = new WebGLRenderer({ antialias: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1));
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.setClearColor(new Color(SKY), 1);
  host.appendChild(renderer.domElement);

  const resize = () => renderer.setSize(Math.max(1, host.clientWidth), Math.max(1, host.clientHeight), false);
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  resize();

  let last = performance.now();
  let raf = 0;
  const loop = (now: number) => {
    onFrame(now - last);
    last = now;
    renderer.clear();
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);

  return {
    dispose() {
      cancelAnimationFrame(raf);
      observer.disconnect();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
