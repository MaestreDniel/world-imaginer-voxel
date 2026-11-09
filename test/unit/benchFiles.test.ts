import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { enterFileFailures, pasteFailures, pasteGateOf, persistFailures, screenFailures, type EnterFileOf, type PasteOf, type PersistOf } from '../harness/benchFiles';

const ASSETS_SP6A = new URL('../../docs/superpowers/specs/assets/sp6a/', import.meta.url);
const read = <T>(file: string): T => JSON.parse(readFileSync(new URL(file, ASSETS_SP6A), 'utf8')) as T;

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

  test('enterFileFailures: the gated Iris file passes; the RTX file is not the Iris\'s (SP5c\'s stayed fullscreen)', () => {
    expect(enterFileFailures(read<EnterFileOf>('enter-iris-chrome.json'))).toEqual([]);
    expect(enterFileFailures(read<EnterFileOf>('enter-rtx-chrome.json'))).toEqual(['gpu rtx, not iris']);
  });

  test('enterFileFailures: six pairs and ratios, each (b) / (a), and `enterRatio` the median of pairRatios[1..5]', () => {
    expect(enterFileFailures(enterFile([150, 105, 104, 102, 106, 108]))).toEqual([]);
    // Five pairs (an older build) and the ratios cut to match.
    const five = enterFile([105, 104, 102, 106, 108]);
    expect(enterFileFailures(five)).toEqual(['5 pairs, not 6', '5 pairRatios, not 6']);
    // A stored ratio that is not its pair's (b) / (a).
    const swapped = enterFile([150, 105, 104, 102, 106, 108]);
    expect(enterFileFailures({ ...swapped, pairRatios: swapped.pairRatios.map((r, i) => (i === 2 ? 1 / r! : r)) })[0]).toMatch(/^pairRatios\[2\] 0\.96\d*, not \(b\) \/ \(a\) 1\.04$/);
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

/** A `paste` block with every operation 'ok' and shown: L12b's 28 at 100 + i ms, L12c's 12 at 1,000 + 10 i ms. */
function pasteBlock(over: Partial<PasteOf> = {}): PasteOf {
  const op = (part: string, i: number, pasteVisibleMs: number | null) => ({ op: i % 2 === 0 ? 'paste' : 'undo', part, answer: 'ok', pasteVisibleMs });
  const ops = [
    ...Array.from({ length: 28 }, (_, i) => op('L12b', i, 100 + i)),
    ...Array.from({ length: 12 }, (_, i) => op('L12c', i, 1000 + 10 * i)),
  ];
  const part = (p95: number | null, over33: number, ghostSliceMaxMs: number | null) => ({ p95, over33, ghostSliceMaxMs });
  return {
    L12a: part(4.165, 0, null), L12b: part(4.17, 0, 1.2), L12c: part(8.33, 1, 0.8), L12d: part(5, 2, 2.5),
    ops, timedOut: [], stoppedBy: null, ...over,
  };
}

describe('the committed bench files\' `paste` block and `G2.paste`\'s parts (SP5c spec §10.4, D28)', () => {
  test('pasteGateOf: the six parts from L12a-L12d and L12b\'s and L12c\'s operations', () => {
    const g = pasteGateOf(pasteBlock());
    expect(g.pasteOver33, 'L12b\'s + L12c\'s over33').toBe(1);
    expect(g.sweepOver33, 'L12d\'s over33').toBe(2);
    expect(g.pasteP95AddedMs, 'the largest of L12b-L12d\'s p95 minus L12a\'s').toBeCloseTo(8.33 - 4.165, 9);
    // Nearest rank: the 27th of 28 (ceil(0.95 · 28) = 27), 100 + 26.
    expect(g.housePasteVisibleP95, 'the nearest-rank p95 of L12b\'s 28').toBe(126);
    expect(g.maxPasteVisibleMax, 'L12c\'s largest').toBe(1110);
    expect(g.ghostSliceMaxMs, 'the longest slice of any part').toBe(2.5);
    // L12c\'s and L12d\'s operations do not enter the house\'s p95, nor L12b\'s the maximum.
    const b = pasteBlock();
    const slow = { ...b, ops: b.ops.map((o) => (o.part === 'L12c' ? { ...o, pasteVisibleMs: 5 } : o)) };
    expect(pasteGateOf(slow).housePasteVisibleP95).toBe(126);
    expect(pasteGateOf(slow).maxPasteVisibleMax).toBe(5);
  });

  test('pasteFailures: a whole L12 passes; a stopped, timed-out, short, refused or unshown one does not', () => {
    expect(pasteFailures(pasteBlock())).toEqual([]);
    expect(pasteFailures(pasteBlock({ stoppedBy: 'L12b\'s paste (operation 3): Can\'t paste here' }))).toEqual(['stoppedBy L12b\'s paste (operation 3): Can\'t paste here']);
    expect(pasteFailures(pasteBlock({ timedOut: ['L12c'] }))).toEqual(['timedOut L12c']);
    const b = pasteBlock();
    expect(pasteFailures({ ...b, ops: b.ops.slice(1) })).toEqual(['27 L12b operations, not 28']);
    expect(pasteFailures({ ...b, ops: b.ops.slice(0, -1) })).toEqual(['11 L12c operations, not 12']);
    expect(pasteFailures({ ...b, ops: b.ops.map((o, i) => (i === 3 ? { ...o, answer: 'full' } : o)) })).toEqual(['1 L12b operations not \'ok\'']);
    expect(pasteFailures({ ...b, ops: b.ops.map((o, i) => (i === 30 ? { ...o, pasteVisibleMs: null } : o)) })).toEqual(['1 L12c operations never shown']);
    expect(pasteFailures({ ...b, L12a: { ...b.L12a, p95: null } })).toEqual(['L12a\'s frame p95 not measured']);
    const noSlices = { ...b, L12b: { ...b.L12b, ghostSliceMaxMs: null }, L12c: { ...b.L12c, ghostSliceMaxMs: null }, L12d: { ...b.L12d, ghostSliceMaxMs: null } };
    expect(pasteFailures(noSlices)).toEqual(['no ghost build slice timed']);
    expect(Number.isNaN(pasteGateOf(noSlices).ghostSliceMaxMs), 'a missing figure gates as NaN').toBe(true);
  });

  test('pasteFailures: the committed Iris Xe Chrome bench file\'s L12 ran whole', () => {
    expect(pasteFailures(read<{ paste: PasteOf }>('bench-iris-chrome.json').paste)).toEqual([]);
  });
});
