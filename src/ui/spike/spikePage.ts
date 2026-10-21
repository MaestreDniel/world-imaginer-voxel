import { probeCapabilities } from '../../engine/capabilities';
import type { CapabilityReport } from '../../engine/capabilityRules';
import { runStoreSpike, type StoreSpikeResult } from '../../engine/spikeStore';
import { runRenderSpike, type RenderSpikeResult } from '../../render/spike/spikeBench';
import { selectSectionRenderer, type SectionRendererKind } from '../../render/sectionRenderer';
import { spikeVerdict, type SpikeVerdict } from './verdict';

/**
 * The spike page, `?spike=batch` (SP4a spec §1, D33): probes the capabilities, runs the shared-store spike, then the
 * render spike on the section renderer the probe selects (`?renderer=batch|mesh` overrides it), and publishes the
 * result as `window.__wiSpike.result` for `test/tools/measureChrome.ts`, with a "Download JSON" button for the
 * Firefox cells the user runs by hand (spec §1.2). The page cannot write files.
 */

export interface SpikePageResult {
  readonly route: 'spike';
  /** The capability report as probed: the renderer string as reported (masked on Firefox), multiDraw, timerQuery. */
  readonly capability: CapabilityReport;
  readonly sectionRenderer: SectionRendererKind;
  readonly userAgent: string;
  readonly screen: { readonly width: number; readonly height: number };
  readonly dpr: number;
  /** The display interval the frame times are snapped to (rulings P56: recorded in every JSON). */
  readonly displayIntervalMs: number;
  readonly items: RenderSpikeResult;
  readonly store: StoreSpikeResult;
  readonly verdict: SpikeVerdict;
}

declare global {
  interface Window {
    /** The spike's result once it has run, or `{ error }` if the page itself failed (read by measureChrome.ts). */
    __wiSpike?: { result: SpikePageResult | { readonly route: 'spike'; readonly error: string } };
  }
}

const rendererOverride = (q: URLSearchParams): SectionRendererKind | null => {
  const r = q.get('renderer');
  return r === 'batch' || r === 'mesh' ? r : null;
};

/** The download's file name: `spike-<browser>.json`; the user names the GPU when sending it. */
const fileName = (ua: string): string => `spike-${/firefox/i.test(ua) ? 'firefox' : /chrome/i.test(ua) ? 'chrome' : 'browser'}.json`;

export async function mountSpikePage(root: HTMLElement): Promise<void> {
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;overflow:hidden;background:#000';
  const panel = document.createElement('div');
  panel.style.cssText = 'position:fixed;left:8px;top:8px;z-index:1;display:flex;gap:8px;align-items:center;padding:4px 8px;'
    + 'background:rgba(15,22,41,.85);border-radius:4px;font:13px/1.4 system-ui,sans-serif;color:#e0e0e0';
  const status = document.createElement('span');
  status.textContent = 'Spike: probing capabilities…';
  panel.append(status);
  root.replaceChildren(host, panel);
  const say = (s: string) => { status.textContent = `Spike: ${s}`; };

  let result: SpikePageResult | { readonly route: 'spike'; readonly error: string };
  try {
    const capability = await probeCapabilities();
    const kind = selectSectionRenderer(capability, rendererOverride(new URLSearchParams(location.search)));
    say('shared store (6 workers)…');
    const store = await runStoreSpike();
    say(`render spike on ${kind === 'batch' ? 'RegionBatch' : 'RegionMesh'} (about 20 s; keep this tab in front)…`);
    const items = await runRenderSpike(host, { kind, maskMultiDraw: capability.multiDraw });
    const verdict = spikeVerdict({ items, store });
    result = {
      route: 'spike',
      capability,
      sectionRenderer: kind,
      userAgent: navigator.userAgent,
      screen: { width: screen.width, height: screen.height },
      dpr: devicePixelRatio,
      displayIntervalMs: items.static.displayIntervalMs,
      items,
      store,
      verdict,
    };
    say(`done: gate ${verdict.gatePass ? 'pass' : 'fail'}, basic ${verdict.basicPass ? 'pass' : 'fail'}`
      + `${verdict.failures.length === 0 ? '' : ` (${verdict.failures.join('; ')})`}`);
  } catch (e) {
    const error = e instanceof Error ? e.stack ?? e.message : String(e);
    result = { route: 'spike', error };
    say(`failed: ${error}`);
  }
  window.__wiSpike = { result };

  const download = document.createElement('button');
  download.type = 'button';
  download.textContent = 'Download JSON';
  download.addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([`${JSON.stringify(result, null, 2)}\n`], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName(navigator.userAgent);
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  });
  panel.append(download);
}
