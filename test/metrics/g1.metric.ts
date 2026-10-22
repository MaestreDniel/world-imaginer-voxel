import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { metricTest } from '../harness/metric';

/**
 * G1's static cells (SP4a spec §9.1, §9.5, D24), every tier, milliseconds: read from the committed Chrome flight on the
 * Iris Xe, `docs/superpowers/specs/assets/sp4a/flight-iris-chrome.json` (`npm run measure:chrome -- --route flight`,
 * the `?flight=sp4a` route). Its shape is checked first: the route's JSON with the renderer naming the Iris Xe (as
 * reported), the section renderer RegionBatch ('batch'), RD 12 and the default profile. The three gated parts:
 * - `mediumStaticP95`: the snapped frame times' p95 (`frames.p95`), max 16.7;
 * - `mediumStaticDrawCalls`: the draw calls' max (`drawCalls.max`), max 100;
 * - `mediumStaticMainP95`: the main-thread ms' p95 (`main.p95`), max 6.
 * The other flights (the 4-worker Iris run, the RTX, and the user's Firefox cells) are recorded, when present, in
 * `.out/G1.others.json`, never gated (§9.5: the Firefox cells are checked at the exit). SP4b's `?bench` re-asserts
 * these cells while streaming and adds the streaming ones (§13.1).
 */
const ASSETS = fileURLToPath(new URL('../../docs/superpowers/specs/assets/sp4a/', import.meta.url));
const OUT_DIR = fileURLToPath(new URL('./.out/', import.meta.url));
const GATED = 'flight-iris-chrome.json';
const OTHERS = ['flight-iris-chrome-w4.json', 'flight-rtx-chrome.json', 'flight-iris-firefox.json', 'flight-rtx-firefox.json'] as const;

/** The parts of a flight JSON G1 reads (`src/ui/world/flight.ts`' FlightResult, plus measureChrome's additions). */
interface Flight {
  readonly route: string;
  readonly profile: string;
  readonly rd: number;
  readonly workers: number;
  readonly sectionRenderer: string;
  readonly renderer: string | null;
  readonly displayIntervalMs: number;
  readonly frames: { readonly count: number; readonly p95: number; readonly over33: number };
  readonly main: { readonly p95: number };
  readonly gpuMs: { readonly p95: number } | null;
  readonly drawCalls: { readonly max: number };
  readonly load: { readonly revealMs: number | null };
}

const read = (file: string): Flight => JSON.parse(readFileSync(join(ASSETS, file), 'utf8')) as Flight;

metricTest('G1', ['mediumStaticP95', 'mediumStaticDrawCalls', 'mediumStaticMainP95'], () => {
  expect(existsSync(join(ASSETS, GATED)), `${GATED} missing: run npm run measure:chrome -- --route flight --gpu iris`).toBe(true);
  const f = read(GATED);
  expect(f.route, 'the ?flight=sp4a JSON').toBe('flight=sp4a');
  expect(f.renderer ?? '', 'the renderer names the Iris Xe').toMatch(/Iris/i);
  expect(f.sectionRenderer, 'measured on RegionBatch').toBe('batch');
  expect(f.rd, 'at RD 12').toBe(12);
  expect(f.profile, 'on the default profile').toBe('default');
  expect(f.frames.count, 'a flight was measured').toBeGreaterThan(0);

  const others: Record<string, unknown> = {};
  for (const file of OTHERS) {
    if (!existsSync(join(ASSETS, file))) continue;
    const o = read(file);
    others[file] = {
      renderer: o.renderer, sectionRenderer: o.sectionRenderer, workers: o.workers, displayIntervalMs: o.displayIntervalMs,
      p95: o.frames.p95, over33: o.frames.over33, drawCallsMax: o.drawCalls.max, mainP95: o.main.p95, gpuP95: o.gpuMs?.p95 ?? null,
      revealMs: o.load.revealMs,
    };
  }
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'G1.others.json'), `${JSON.stringify({ id: 'G1', tier: process.env.METRICS_TIER ?? null, others }, null, 2)}\n`);

  return {
    mediumStaticP95: f.frames.p95,
    mediumStaticDrawCalls: f.drawCalls.max,
    mediumStaticMainP95: f.main.p95,
    displayIntervalMs: f.displayIntervalMs,
    over33: f.frames.over33,
    workers: f.workers,
  };
});
