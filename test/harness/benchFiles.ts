/**
 * Cross-checks of the committed browser files that `g1.metric.ts` gates (SP5b spec §6.2; final review GOV-4): each
 * derived figure the tool or the page stored is recomputed from the figures it derives from, and the window and the
 * viewport are the measured ones, so a file from an older tool build, a hand-merged file (another statistic) or one
 * measured out of fullscreen is refused rather than gated. Each returns the failures as text, [] when none.
 */

/** The measured window and viewport (SP4a spec §1.2 item 2, §9.5): fullscreen 1920 × 1080 @ 1. */
export const MEASURED_SCREEN = { width: 1920, height: 1080, dpr: 1 } as const;
/** The enter route's pairs, the first (the cold cache) discarded (SP5b spec §6.2). */
export const ENTER_FILE_PAIRS = 6;
/** How far a stored figure may sit from its recomputed value (a JSON round trip keeps doubles exact; sums may not). */
const EPS = 1e-9;

/** measureChrome's additions every Chrome file carries. */
export interface ScreenOf {
  readonly window?: { readonly width: number; readonly height: number; readonly windowState: string } | null;
  readonly viewport?: { readonly innerWidth: number; readonly innerHeight: number; readonly devicePixelRatio: number } | null;
}

/** The window fullscreen at 1920 × 1080 and the viewport 1920 × 1080 @ 1 at the run's end. */
export function screenFailures(f: ScreenOf): string[] {
  const out: string[] = [];
  const w = f.window;
  if (w === undefined || w === null) out.push('no window recorded');
  else {
    if (w.windowState !== 'fullscreen') out.push(`window ${w.windowState}, not fullscreen`);
    if (w.width !== MEASURED_SCREEN.width || w.height !== MEASURED_SCREEN.height) out.push(`window ${w.width} × ${w.height}, not 1920 × 1080`);
  }
  const v = f.viewport;
  if (v === undefined || v === null) out.push('no viewport recorded');
  else if (v.innerWidth !== MEASURED_SCREEN.width || v.innerHeight !== MEASURED_SCREEN.height || v.devicePixelRatio !== MEASURED_SCREEN.dpr) {
    out.push(`viewport ${v.innerWidth} × ${v.innerHeight} @ ${v.devicePixelRatio}, not 1920 × 1080 @ 1`);
  }
  return out;
}

const close = (a: number, b: number): boolean => Math.abs(a - b) <= EPS * Math.max(1, Math.abs(a), Math.abs(b));
const sameOrNull = (stored: number | null, recomputed: number | null): boolean =>
  stored === null || recomputed === null ? stored === recomputed : close(stored, recomputed);
const fmt = (v: number | null): string => (v === null ? 'null' : String(v));

function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const v = [...values].sort((a, b) => a - b);
  const m = v.length >> 1;
  return v.length % 2 === 1 ? v[m]! : (v[m - 1]! + v[m]!) / 2;
}

/** One load of an enter file. */
interface EnterLoadOf {
  readonly revealMs: number | null;
}

/** The parts of an enter file the cross-check reads (`bench.ts`' EnterSummary, plus measureChrome's additions). */
export interface EnterFileOf extends ScreenOf {
  readonly gpu?: string;
  readonly pairs: ReadonlyArray<{ readonly unsaved: EnterLoadOf; readonly saved: EnterLoadOf }>;
  readonly pairRatios: ReadonlyArray<number | null>;
  readonly enterRatio: number | null;
}

/**
 * An enter file (rulings R8): six pairs and six `pairRatios`, each (b) / (a) `revealMs` of its pair (null without both
 * or with (a) not positive), `enterRatio` the median of `pairRatios[1..5]`'s numbers, measured on the Iris Xe (`gpu`
 * 'iris') fullscreen at 1920 × 1080 @ 1.
 */
export function enterFileFailures(e: EnterFileOf): string[] {
  const out: string[] = [];
  if (e.gpu !== 'iris') out.push(`gpu ${String(e.gpu)}, not iris`);
  if (e.pairs.length !== ENTER_FILE_PAIRS) out.push(`${e.pairs.length} pairs, not ${ENTER_FILE_PAIRS}`);
  if (e.pairRatios.length !== ENTER_FILE_PAIRS) out.push(`${e.pairRatios.length} pairRatios, not ${ENTER_FILE_PAIRS}`);
  e.pairs.forEach((p, i) => {
    const a = p.unsaved.revealMs;
    const b = p.saved.revealMs;
    const ratio = a === null || b === null || !Number.isFinite(a) || !Number.isFinite(b) || a <= 0 ? null : b / a;
    const stored = e.pairRatios[i] ?? null;
    if (!sameOrNull(stored, ratio)) out.push(`pairRatios[${i}] ${fmt(stored)}, not (b) / (a) ${fmt(ratio)}`);
  });
  const kept = e.pairRatios.slice(1).filter((v): v is number => v !== null && Number.isFinite(v));
  const median = medianOf(kept);
  if (!sameOrNull(e.enterRatio, median)) out.push(`enterRatio ${fmt(e.enterRatio)}, not the median of pairRatios[1..5] ${fmt(median)}`);
  out.push(...screenFailures(e));
  return out;
}

/** One L11 part's figures (`bench.ts`' SavePartFigures). */
interface SavePartOf {
  readonly p95: number;
  readonly over33: number;
  readonly editVisibleP95: number | null;
}

/** The parts of a `persist` block the cross-check reads (`bench.ts`' PersistFigures). */
export interface PersistOf {
  readonly L11a: SavePartOf;
  readonly L11b: SavePartOf;
  readonly L11c: SavePartOf;
  readonly L11d: SavePartOf;
  readonly over33Added: number;
  readonly p95AddedMs: number;
  readonly editVisibleAddedMs: number | null;
}

/**
 * A `persist` block's added parts, recomputed from L11a-L11d ("on" L11b and L11d, "off" L11a and L11c): `over33Added`
 * the "on" sum minus the "off" sum, `p95AddedMs` the "on" mean frame p95 minus the "off" mean, `editVisibleAddedMs` the
 * same difference of `editVisibleP95` (null when a part has none).
 */
export function persistFailures(p: PersistOf): string[] {
  const out: string[] = [];
  const on = [p.L11b, p.L11d];
  const off = [p.L11a, p.L11c];
  const sum = (ps: readonly SavePartOf[], f: (s: SavePartOf) => number): number => ps.reduce((a, s) => a + f(s), 0);
  const over33 = sum(on, (s) => s.over33) - sum(off, (s) => s.over33);
  if (p.over33Added !== over33) out.push(`over33Added ${p.over33Added}, not L11b + L11d − L11a − L11c ${over33}`);
  const p95 = sum(on, (s) => s.p95) / on.length - sum(off, (s) => s.p95) / off.length;
  if (!close(p.p95AddedMs, p95)) out.push(`p95AddedMs ${p.p95AddedMs}, not the "on" mean p95 − the "off" mean ${p95}`);
  const visible = (ps: readonly SavePartOf[]): number | null =>
    ps.some((s) => s.editVisibleP95 === null) ? null : sum(ps, (s) => s.editVisibleP95!) / ps.length;
  const vOn = visible(on);
  const vOff = visible(off);
  const added = vOn === null || vOff === null ? null : vOn - vOff;
  if (!sameOrNull(p.editVisibleAddedMs, added)) out.push(`editVisibleAddedMs ${fmt(p.editVisibleAddedMs)}, not the "on" mean editVisibleP95 − the "off" mean ${fmt(added)}`);
  return out;
}

/** L12's operations `G2.paste` reads (SP5c spec §10.4): L12b's 28 (the house's) and L12c's 12 (the maximum blocks'). */
export const PASTE_OPS = { L12b: 28, L12c: 12 } as const;

/** One L12 part's figures the gate reads (`bench.ts`' PastePartFigures). */
interface PastePartOf {
  readonly p95: number | null;
  readonly over33: number;
  readonly ghostSliceMaxMs: number | null;
}

/** One L12 operation's figures the gate reads (`bench.ts`' PasteOpFigures). */
interface PasteOpOf {
  readonly op: string;
  readonly part: string;
  readonly answer: string;
  readonly pasteVisibleMs: number | null;
}

/** The parts of a `paste` block the gate reads (`bench.ts`' PasteFigures). */
export interface PasteOf {
  readonly L12a: PastePartOf;
  readonly L12b: PastePartOf;
  readonly L12c: PastePartOf;
  readonly L12d: PastePartOf;
  readonly ops: readonly PasteOpOf[];
  readonly timedOut: readonly string[];
  readonly stoppedBy: string | null;
}

/** `G2.paste`'s six gated parts (SP5c spec §10.4, D28). */
export interface PasteGate {
  readonly pasteOver33: number;
  readonly sweepOver33: number;
  readonly pasteP95AddedMs: number;
  readonly housePasteVisibleP95: number;
  readonly maxPasteVisibleMax: number;
  readonly ghostSliceMaxMs: number;
}

/** The nearest-rank percentile `p` of `values` (`src/ui/frameStats.ts`' rule, the bench's), null with none. */
function nearestRankOf(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const v = [...values].sort((a, b) => a - b);
  return v[Math.min(v.length - 1, Math.max(0, Math.ceil(p * v.length) - 1))]!;
}

const visibleOf = (p: PasteOf, part: 'L12b' | 'L12c'): number[] =>
  p.ops.filter((o) => o.part === part && o.pasteVisibleMs !== null).map((o) => o.pasteVisibleMs!);

/**
 * A `paste` block's shape before it is gated: L12 ran to its end (`timedOut` empty, `stoppedBy` null, Task 31's extra
 * key), L12b's 28 and L12c's 12 operations present, each answered 'ok' and shown (`pasteVisibleMs` measured), every
 * part's frame p95 measured and at least one ghost build's slice timed.
 */
export function pasteFailures(p: PasteOf): string[] {
  const out: string[] = [];
  if (p.timedOut.length > 0) out.push(`timedOut ${p.timedOut.join(', ')}`);
  if (p.stoppedBy !== null) out.push(`stoppedBy ${p.stoppedBy}`);
  for (const part of ['L12b', 'L12c'] as const) {
    const ops = p.ops.filter((o) => o.part === part);
    if (ops.length !== PASTE_OPS[part]) out.push(`${ops.length} ${part} operations, not ${PASTE_OPS[part]}`);
    const notOk = ops.filter((o) => o.answer !== 'ok').length;
    if (notOk > 0) out.push(`${notOk} ${part} operations not 'ok'`);
    const unshown = ops.filter((o) => o.pasteVisibleMs === null).length;
    if (unshown > 0) out.push(`${unshown} ${part} operations never shown`);
  }
  for (const part of ['L12a', 'L12b', 'L12c', 'L12d'] as const) {
    if (p[part].p95 === null) out.push(`${part}'s frame p95 not measured`);
  }
  if ([p.L12b, p.L12c, p.L12d].every((s) => s.ghostSliceMaxMs === null)) out.push('no ghost build slice timed');
  return out;
}

/**
 * `G2.paste`'s six parts from a `paste` block (SP5c spec §10.4): `pasteOver33` L12b's + L12c's `over33`, `sweepOver33`
 * L12d's, `pasteP95AddedMs` the largest of L12b's, L12c's and L12d's frame p95 minus L12a's, `housePasteVisibleP95` the
 * nearest-rank p95 of L12b's operations' `pasteVisibleMs`, `maxPasteVisibleMax` the largest of L12c's, `ghostSliceMaxMs`
 * the longest slice recorded in any part. Call it on a block `pasteFailures` passes: a missing figure is NaN, which no
 * gate passes.
 */
export function pasteGateOf(p: PasteOf): PasteGate {
  const num = (v: number | null): number => v ?? Number.NaN;
  const slices = [p.L12a, p.L12b, p.L12c, p.L12d].map((s) => s.ghostSliceMaxMs).filter((v): v is number => v !== null);
  const maxVisible = visibleOf(p, 'L12c');
  return {
    pasteOver33: p.L12b.over33 + p.L12c.over33,
    sweepOver33: p.L12d.over33,
    pasteP95AddedMs: Math.max(num(p.L12b.p95), num(p.L12c.p95), num(p.L12d.p95)) - num(p.L12a.p95),
    housePasteVisibleP95: num(nearestRankOf(visibleOf(p, 'L12b'), 0.95)),
    maxPasteVisibleMax: maxVisible.length === 0 ? Number.NaN : Math.max(...maxVisible),
    ghostSliceMaxMs: slices.length === 0 ? Number.NaN : Math.max(...slices),
  };
}
