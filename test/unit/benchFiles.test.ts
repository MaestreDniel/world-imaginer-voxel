import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { enterFileFailures, persistFailures, screenFailures, type EnterFileOf, type PersistOf } from '../harness/benchFiles';

const ASSETS_SP5B = new URL('../../docs/superpowers/specs/assets/sp5b/', import.meta.url);
const read = <T>(file: string): T => JSON.parse(readFileSync(new URL(file, ASSETS_SP5B), 'utf8')) as T;

const FULL = { window: { width: 1920, height: 1080, windowState: 'fullscreen' }, viewport: { innerWidth: 1920, innerHeight: 1080, devicePixelRatio: 1 } };

/** Six pairs whose (a) is 100 ms and (b) the given ms: ratios b / 100. */
function enterFile(saved: readonly number[], over: Partial<EnterFileOf> = {}): EnterFileOf {
  const pairs = saved.map((b) => ({ unsaved: { revealMs: 100 }, saved: { revealMs: b } }));
  const pairRatios = saved.map((b) => b / 100);
  const kept = pairRatios.slice(1).sort((x, y) => x - y);
  const m = kept.length >> 1;
  const enterRatio = kept.length % 2 === 1 ? kept[m]! : (kept[m - 1]! + kept[m]!) / 2;
  return { gpu: 'iris', pairs, pairRatios, enterRatio, ...FULL, ...over };
}

describe('the committed browser files\' derived figures (SP5b spec §6.2; final review GOV-4)', () => {
  test('screenFailures: fullscreen 1920 × 1080 and a 1920 × 1080 @ 1 viewport pass; the RTX enter cell\'s end state does not', () => {
    expect(screenFailures(FULL)).toEqual([]);
    expect(screenFailures({ window: { width: 1919, height: 1079, windowState: 'normal' }, viewport: { innerWidth: 1875, innerHeight: 948, devicePixelRatio: 1 } })).toEqual([
      'window normal, not fullscreen', 'window 1919 × 1079, not 1920 × 1080', 'viewport 1875 × 948 @ 1, not 1920 × 1080 @ 1',
    ]);
    expect(screenFailures({})).toEqual(['no window recorded', 'no viewport recorded']);
    expect(screenFailures({ ...FULL, viewport: { innerWidth: 1920, innerHeight: 1080, devicePixelRatio: 2 } })).toEqual(['viewport 1920 × 1080 @ 2, not 1920 × 1080 @ 1']);
  });

  test('enterFileFailures: the gated Iris file passes; the RTX file is not the Iris\'s, and left fullscreen', () => {
    expect(enterFileFailures(read<EnterFileOf>('enter-iris-chrome.json'))).toEqual([]);
    const rtx = enterFileFailures(read<EnterFileOf>('enter-rtx-chrome.json'));
    expect(rtx[0]).toBe('gpu rtx, not iris');
    expect(rtx).toContain('window normal, not fullscreen');
  });

  test('enterFileFailures: six pairs and ratios, each (b) / (a), and `enterRatio` the median of pairRatios[1..5]', () => {
    expect(enterFileFailures(enterFile([150, 105, 104, 102, 106, 108]))).toEqual([]);
    // Five pairs (an older build) and the ratios cut to match.
    const five = enterFile([105, 104, 102, 106, 108]);
    expect(enterFileFailures(five)).toEqual(['5 pairs, not 6', '5 pairRatios, not 6']);
    // A stored ratio that is not its pair's (b) / (a).
    const swapped = enterFile([150, 105, 104, 102, 106, 108]);
    expect(enterFileFailures({ ...swapped, pairRatios: swapped.pairRatios.map((r, i) => (i === 2 ? 1 / r : r)) })[0]).toMatch(/^pairRatios\[2\] 0\.96\d*, not \(b\) \/ \(a\) 1\.04$/);
    // The ratio of the medians (the statistic before rulings R8), or a median over all six, is refused.
    expect(enterFileFailures({ ...swapped, enterRatio: 1.07 })).toEqual(['enterRatio 1.07, not the median of pairRatios[1..5] 1.05']);
    expect(enterFileFailures({ ...swapped, enterRatio: (1.05 + 1.06) / 2 })).toHaveLength(1);
    // A pair with no (b) reveal: its ratio null, and the median over the other four.
    const missing = enterFile([150, 105, 104, 102, 106, 108]);
    const pairs = missing.pairs.map((p, i) => (i === 5 ? { unsaved: p.unsaved, saved: { revealMs: null } } : p));
    const pairRatios = missing.pairRatios.map((r, i) => (i === 5 ? null : r));
    expect(enterFileFailures({ ...missing, pairs, pairRatios, enterRatio: (1.04 + 1.05) / 2 })).toEqual([]);
    expect(enterFileFailures({ ...missing, pairs, pairRatios: missing.pairRatios, enterRatio: (1.04 + 1.05) / 2 })[0]).toBe('pairRatios[5] 1.08, not (b) / (a) null');
    // Measured on another GPU, or out of fullscreen.
    expect(enterFileFailures(enterFile([150, 105, 104, 102, 106, 108], { gpu: 'rtx' }))).toEqual(['gpu rtx, not iris']);
    expect(enterFileFailures(enterFile([150, 105, 104, 102, 106, 108], { window: { width: 1920, height: 1080, windowState: 'normal' } }))).toEqual(['window normal, not fullscreen']);
  });

  test('persistFailures: the committed bench files\' added parts are their parts\' differences', () => {
    for (const file of ['bench-iris-chrome.json', 'bench-iris-chrome-w4.json', 'bench-rtx-chrome.json']) {
      expect(persistFailures(read<{ persist: PersistOf }>(file).persist), file).toEqual([]);
    }
  });

  test('persistFailures: `over33Added`, `p95AddedMs` and `editVisibleAddedMs` recomputed from L11a-L11d', () => {
    const part = (p95: number, over33: number, editVisibleP95: number | null) => ({ p95, over33, editVisibleP95 });
    const p: PersistOf = {
      L11a: part(4, 1, 20), L11b: part(8, 3, 30), L11c: part(4, 0, 10), L11d: part(4, 1, 40),
      over33Added: 3, p95AddedMs: 2, editVisibleAddedMs: 20,
    };
    expect(persistFailures(p)).toEqual([]);
    expect(persistFailures({ ...p, over33Added: 1 })).toEqual(['over33Added 1, not L11b + L11d − L11a − L11c 3']);
    // L11b's p95 alone (a different statistic) in place of the means' difference.
    expect(persistFailures({ ...p, p95AddedMs: 4 })).toEqual(['p95AddedMs 4, not the "on" mean p95 − the "off" mean 2']);
    expect(persistFailures({ ...p, editVisibleAddedMs: 25 })).toEqual(['editVisibleAddedMs 25, not the "on" mean editVisibleP95 − the "off" mean 20']);
    // A part with no `editVisibleP95`: the difference is null, and a stored number is refused.
    const none = { ...p, L11c: part(4, 0, null) };
    expect(persistFailures({ ...none, editVisibleAddedMs: null })).toEqual([]);
    expect(persistFailures(none)).toEqual(['editVisibleAddedMs 20, not the "on" mean editVisibleP95 − the "off" mean null']);
  });
});
