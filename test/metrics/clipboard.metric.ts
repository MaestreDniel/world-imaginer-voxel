import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { expect } from 'vitest';
import { colKey, colKeyCx, colKeyCz } from '../../src/core/coords';
import { canonicalJSON } from '../../src/core/params/canonical';
import { applyPatch } from '../../src/core/params/kit';
import { resolveProfile } from '../../src/core/params/profiles';
import { SCHEMA, type ParamsPatch } from '../../src/core/params/schema';
import { seedFromInput } from '../../src/core/seed';
import { findSpawn } from '../../src/gen/column/spawn';
import { createGenContext } from '../../src/gen/context';
import { CLIPBOARD_KEY, decodeClipboard } from '../../src/persist/clipboard';
import { createMemoryKV, type MemoryKV } from '../../src/persist/memory';
import { createSaves, NO_VALUE, newState, normalizeHistory, todayStateTable, type HistoryRecord, type WorldRecord } from '../../src/persist/saves';
import { createDiffStore, NO_ENTRY } from '../../src/sim/diffStore';
import { applyEdits, createEditScratch, readVolume, type Edit, type EditResult } from '../../src/sim/edits';
import { DEFAULT_MAP_STATE, openMapSession } from '../../src/ui/map/mapState';
import { createActionPost, createBlockHistory, MAX_HISTORY_EDITS, type BlockStep } from '../../src/ui/world/blockHistory';
import { turnedCell, type Clipboard } from '../../src/ui/world/clipboard';
import { createClipboardStore } from '../../src/ui/world/clipboardStore';
import type { EditOutcome } from '../../src/ui/world/editPath';
import { moveBatch, pasteBatch, type Box } from '../../src/ui/world/pasteBatch';
import { pasteLitBlock, pasteMaxBlock } from '../../src/ui/world/pasteBlocks';
import { STATE_BOUNDS } from '../../src/ui/world/stateBounds';
import { createPageAutosave, newWorldRecord } from '../../src/ui/world/worldPage';
import { NO_FLUID, packFluid, WATER_SOURCE } from '../../src/world/blocks/fluid';
import { AIR, REGISTRY, STATE_TYPE, STONE, TYPE_NAMES } from '../../src/world/blocks/index';
import { PLACEABLE } from '../../src/world/blocks/tags';
import type { VoxelStore } from '../../src/world/store/store';
import { freshLightMismatches } from '../harness/lightCheck';
import { currentTier, metricTest } from '../harness/metric';
import { openPersistWorld, type PersistWorld } from '../harness/persistWorld';
import { referenceLight } from '../harness/refs';
import { genRegion } from '../harness/region';
import { testRng } from '../harness/stats';

/**
 * L3, E3 and E5's paste parts (SP5c spec §10.1, D27; master §6.4), in a metrics-quick shard of their own
 * (`clipboard`, spec §11). Every part `max 0` from SP5c, exact, on every tier; every problem names its seed or case.
 *
 * - **`L3.paste`** (`pasteValueMismatches`, `pasteLightMismatches`, `pasteLimboOver`): its own seed-42 region upTo 'L'
 *   of 10 × 10 columns at the spawn on every tier (L3's is 6 × 6 on the fast tier, too small for a 32-wide paste across
 *   a column border with the 5 × 5 reference box), `shared: true`, so a sub-batch's retired slots wait in limbo as in
 *   the sim; the batches through the sim's own `applyEdits` (sub-batched), called outside any read section, and
 *   recorded as one step each by `blockHistory`'s `createActionPost`. K random pastes (seed 0x13ba; 5 on the fast tier,
 *   20 on quick and full): clipboards of 1-32 a side whose cells are drawn from every placeable state (each oriented
 *   state its own draw, so every orientation; wall torches, torches, glass), water sources and levels, waterlogged
 *   ladders and air, a random turn, at a random anchor across a column border in x and in z, inside the region's inner
 *   6 × 6 columns, built by `pasteBatch` over the target as `readVolume` reads it; then one maximum paste (`paste.maxLit`'s
 *   64 × 60 × 32 shells, 32,768 changed, a random turn, into air across column borders); then one move (`moveBatch`)
 *   of a 12 × 10 × 12 box across a column corner holding generated ground, read with its generated values
 *   (`readVolume` with `gen`), turned once onto a target overlapping it. After each: every cell of the box against the
 *   turned clipboard, and after the move every source cell outside the target against a fresh `genRegion` upTo 'D' of
 *   its columns (`pasteValueMismatches`); every touched column's 3 × 3 against a fresh `lightRegion`
 *   (`freshLightMismatches`), and after every 5th paste and the maximum `referenceLight` over the box grown by 16 on
 *   each side (light travels at most 14) on the box's footprint (`pasteLightMismatches`); `pasteLimboOver` counts the
 *   pastes (the maximum included) whose `limboMax` is above 4,096 slots. Every odd paste and the move are undone at
 *   once by `blockHistory`'s inverse batch (`undo`) and checked the same way against the values before.
 * - **`E3.paste`** (`pasteUndoMismatches`, `pasteRedoMismatches`, `clipboardReloadMismatches`, `pasteLeaveMismatches`):
 *   worlds of seed 42 opened in process through `openPersistWorld` at RD 4 over a `MemoryKV`, the clipboard on a second
 *   `MemoryKV` (`clipKv`, passed to every open), the tool driven as the page drives it (`select`: corners by
 *   `tool.placed`, Ctrl+C, Ctrl+X, Ctrl+V and N, then `placeAt(…, true)` and `confirm()`). The script, in order:
 *   a house (oak planks, glass, oak logs on the three axes, wall torches and ladders in the four facings, a waterlogged
 *   ladder, a water source) built in air and copied; pasted across two column borders turned once; undone and redone
 *   three times, each against the state before and after the paste: every cell of the box and a one-cell shell, the
 *   DiffStore entries of its columns (`diff`) and their 3 × 3s' light against a fresh `lightRegion`; flushed, disposed
 *   and reopened; undone and redone again. A second world whose stored `stateTable` is today's reversed pastes the same
 *   clipboard: every cell equal to it by state key, again after its flush and reopen. The clipboard after the reopen
 *   equal to the one before (the stored record, its sizes and cells), and pasted turned once equal to the pre-reload
 *   paste; that paste moved 3 blocks down (overlapping itself) with N and undone (both boxes and the shell as before).
 *   Review Focus 5: the house pasted where at least 40 target cells held generated ground, at the place of four where a
 *   'T' change (`density.detailAmpLo` and `detailAmpHi` 8) raises the surface most (a `genRegion` upTo 'D' of the new
 *   parameters); a box across the surface copied; the mode on and that change applied (one backup posted and committed,
 *   its history ending with the paste's step); Ctrl+Z: each cell of the step whose `before` is `NO_ENTRY` equals the
 *   new generated value (`copy` with `gen`), each other its `before`; Ctrl+Y: each cell its `after`. The house, now
 *   partly inside the new ground, moved up 4 with one step: the target the source as read, every source cell outside it
 *   the new generated terrain; one undo restores both boxes. The copy made before the change pasted after it: every
 *   cell the copied value. Review Focus 1: a paste, then a second 'T' change applied without waiting
 *   (`change(…, {noWait: true})`); Ctrl+Z while it regenerates refused by the gate, the step kept: `Can't undo there:
 *   regenerating` while the step's 3 × 3s are all stale, `… not loaded` once the Apply's first update has freed one of
 *   them (the edit gate's two closed states, SP5a spec §2.1; the coordinator frees stale columns nearest the camera
 *   first, so at RD 4 it is `not loaded`): the notice must be exactly the gate's at the press (`rf1Gate` records it); once
 *   the world settles, Ctrl+Z restores the step's cells (a `NO_ENTRY` before → the new generated value). Last on that
 *   world (rulings P10): a cut of the house whose clipboard write is `crashNext()`ed (never settles; the cut is not
 *   awaited): frames until the write was issued, plus 50: no `edits` posted, every cell of the box unchanged, the
 *   history's size unchanged; then disposed. **The leave**, on the reopened world: a maximum paste (`paste.max`'s 32³
 *   block, 32,768 changed) whose `edits` reply is delayed 1,500 ms, `leave()` (the autosave's `beforeLeave`, then
 *   dispose) while it is pending, reopened: every cell of the box the block's and the history ending with its
 *   32,768-edit step. Last, Review Focus 5's backup opened and its last step undone: every cell of the house's box the
 *   value before the paste (the old parameters' terrain).
 *   Counted: the undo checks, the refused undo and the backup's history and undo in `pasteUndoMismatches`; the pasted,
 *   moved and redone cells in `pasteRedoMismatches`; the clipboard across the reload and the second world, the copy
 *   before the change and the crashed cut in `clipboardReloadMismatches`; the leave in `pasteLeaveMismatches`.
 * - **`E5.paste`** (`pasteStale`): a world at RD 4, a maximum paste across column borders; a teleport of 640 columns
 *   until the pasted columns' 3 × 3s are freed (`published` false), back until filled: every pasted cell at its latest
 *   value and the 3 × 3s' light against a fresh `lightRegion` (E5.session's script, `edit.metric.ts`). Review Focus 1: a
 *   second maximum paste on top of the first with its `edits` reply delayed 1,500 ms; 100 ms after its post a teleport
 *   of 640 columns: every frame until the reply, each column of the pasted 3 × 3s still pinned (`pinned`) and not freed
 *   (`published`); after the reply the columns are freed; back: both pastes' cells at their values and their light.
 *   `pasteStale` counts the stale cells, the light mismatches and the columns unpinned or freed before the reply.
 * - **Recorded, not gated:** `.out/L3.paste.json` with each batch's `editMs`, `relightMs`, `subBatchMaxMs`,
 *   `limboMax` and each pool's byte length before and after in `.out/L3.paste.batches.json`; `.out/E3.paste.json` with
 *   the DiffStore's entries and the load's decode time after the pastes and, with a 65,536-edit history (two steps of
 *   32,768), the open's normalise-and-restore time (`normalizeHistory` and `restore`) and the first flush's main-thread
 *   clone, timed as `structuredClone` of the flush message the page's autosave builds (its state and whole history, as
 *   `simClient` sends the first flush after a load; the in-process sim clones nothing).
 */
const TIER = currentTier();
const FAST = TIER === 'fast';
const RD = 4;
/** The problems listed per part. */
const PROBLEMS = 20;
const OUT_DIR = fileURLToPath(new URL('./.out/', import.meta.url));

/** L3.paste's region side, random pastes and `referenceLight` period (spec §10.1). */
const L3_SIZE = 10;
const L3_PASTES = FAST ? 5 : 20;
const L3_REFERENCE_EVERY = 5;
const L3_SEED = 0x13ba;
/** The limbo bound of a maximum paste (spec §3.2, §10.5). */
const LIMBO_BOUND = 4096;
/** The reply delay of the leave's and Review Focus 1's maximum pastes (past the leave's 1,000 ms). */
const SLOW_MS = 1500;
const TELEPORT = 640;

const now = (): number => performance.now();
const round3 = (x: number): number => Math.round(x * 1000) / 1000;
const val = (state: number, fluid = NO_FLUID): number => ((state << 8) | fluid) >>> 0;
const stateOf = (key: string): number => REGISTRY.parseStateKey(key);
/** A value by its state key and fluid byte (a world's own ids never compared across worlds). */
const keyOf = (v: number): string => `${REGISTRY.stateKey(v >>> 8)}+${v & 255}`;

interface Problems {
  readonly list: string[];
  add(s: string): void;
}
function problemList(): Problems {
  const list: string[] = [];
  return { list, add: (s) => { if (list.length < PROBLEMS) list.push(s); } };
}

/** The columns (colKeys) a box covers. */
function colsOf(b: Box): number[] {
  const out: number[] = [];
  for (let cz = b.z0 >> 4; cz <= (b.z0 + b.d - 1) >> 4; cz++) for (let cx = b.x0 >> 4; cx <= (b.x0 + b.w - 1) >> 4; cx++) out.push(colKey(cx, cz));
  return out;
}
/** Every column of the 3 × 3s around `cols`. */
function around(cols: Iterable<number>): number[] {
  const out = new Set<number>();
  for (const k of cols) for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) out.add(colKey(colKeyCx(k) + dx, colKeyCz(k) + dz));
  return [...out];
}
const grow = (b: Box): Box => ({ x0: b.x0 - 1, y0: b.y0 - 1, z0: b.z0 - 1, w: b.w + 2, h: b.h + 2, d: b.d + 2 });
function union(a: Box, b: Box): Box {
  const x0 = Math.min(a.x0, b.x0);
  const y0 = Math.min(a.y0, b.y0);
  const z0 = Math.min(a.z0, b.z0);
  return {
    x0, y0, z0,
    w: Math.max(a.x0 + a.w, b.x0 + b.w) - x0,
    h: Math.max(a.y0 + a.h, b.y0 + b.h) - y0,
    d: Math.max(a.z0 + a.d, b.z0 + b.d) - z0,
  };
}
const inBox = (b: Box, x: number, y: number, z: number): boolean =>
  x >= b.x0 && x < b.x0 + b.w && y >= b.y0 && y < b.y0 + b.h && z >= b.z0 && z < b.z0 + b.d;
/** Calls `f` for each cell of `b` with its index in a `copy` reply's order. */
function eachCell(b: Box, f: (x: number, y: number, z: number, i: number) => void): void {
  let i = 0;
  for (let y = b.y0; y < b.y0 + b.h; y++) for (let z = b.z0; z < b.z0 + b.d; z++) for (let x = b.x0; x < b.x0 + b.w; x++, i++) f(x, y, z, i);
}

/** The cells of `got` that differ from `want(i)`, each a problem (the first few). */
function cellDiffs(b: Box, got: Uint32Array, want: (x: number, y: number, z: number, i: number) => number, problems: Problems, what: string): number {
  let n = 0;
  eachCell(b, (x, y, z, i) => {
    const w = want(x, y, z, i);
    if (got[i] === w) return;
    n++;
    problems.add(`${what}: (${x}, ${y}, ${z}) reads ${keyOf(got[i]!)} ≠ ${keyOf(w)}`);
  });
  return n;
}

// ---------------------------------------------------------------- L3.paste

/** Every placeable state, each orientation its own entry (wall torches included), dry; the fluids; air. */
const PALETTE: readonly number[] = (() => {
  const out: number[] = [val(AIR)];
  for (let s = 0; s < REGISTRY.stateCount; s++) {
    const t = STATE_TYPE[s]!;
    if (PLACEABLE[t] === 1 || TYPE_NAMES[t] === 'wall_torch') out.push(val(s));
  }
  for (let level = 0; level < 8; level++) out.push(val(AIR, packFluid(1, level)));
  out.push(val(AIR, packFluid(1, 0, true)));
  for (const f of ['north', 'south', 'east', 'west']) out.push(val(stateOf(`ladder[facing=${f}]`), WATER_SOURCE));
  return out;
})();

/** One batch L3.paste applied, recorded (spec §10.1's last item). */
interface BatchRecord {
  readonly what: string;
  readonly edits: number;
  readonly editMs: number;
  readonly relightMs: number;
  readonly subBatchMaxMs: number;
  readonly limboMax: number;
  readonly blockPoolBefore: number;
  readonly blockPoolAfter: number;
  readonly bytePoolBefore: number;
  readonly bytePoolAfter: number;
}

async function measureL3Paste(): Promise<{ values: Record<string, number>; problems: string[]; batches: BatchRecord[] }> {
  const t0 = now();
  const params = resolveProfile('default');
  const sp = findSpawn(createGenContext(seedFromInput('42'), params));
  const cx0 = (sp.x >> 4) - (L3_SIZE >> 1);
  const cz0 = (sp.z >> 4) - (L3_SIZE >> 1);
  const region = await genRegion({ seed: '42', params, cx0, cz0, w: L3_SIZE, h: L3_SIZE, upTo: 'L', order: 'spiral', threads: 1, shared: true });
  const genSeconds = (now() - t0) / 1000;
  const store = region.view.store;
  const diffs = createDiffStore();
  const scratch = createEditScratch();
  const problems = problemList();
  const report = (s: string): void => problems.add(s);
  const next = testRng(L3_SEED);
  const pick = (n: number): number => next() % n;
  let pasteValueMismatches = 0;
  let pasteLightMismatches = 0;
  let pasteLimboOver = 0;
  let referenceBoxes = 0;
  let compareMs = 0;
  let referenceMs = 0;
  const batches: BatchRecord[] = [];

  // The sim's own apply behind the page's history: one step per accepted batch, undone by its inverse batch.
  let last: EditResult | null = null;
  const post = (edits: readonly Edit[]): Promise<EditOutcome> => {
    last = applyEdits(store, diffs, scratch, edits, now);
    return Promise.resolve(last.refused !== null ? { ok: false, why: last.refused } : { ok: true, prev: last.prev, next: last.next });
  };
  const shown: string[] = [];
  const history = createBlockHistory({
    post,
    read: (x, y, z) => {
      store.enterRead();
      try {
        return val(store.blockAt(x, y, z), store.fluidAt(x, y, z));
      } finally {
        store.exitRead();
      }
    },
    pending: () => false,
    settled: () => Promise.resolve(),
    notices: { show: (t) => { shown.push(t); } },
  });
  const actionPost = createActionPost({ post, record: (s) => history.record(s) });
  const pools = (): [number, number] => [store.blockPool.buffer.byteLength, store.bytePool.buffer.byteLength];

  /** Runs one batch as an action (or an undo), recorded; the result, or null after its problem. */
  const run = async (what: string, f: () => Promise<EditOutcome | null>, n: number): Promise<EditResult | null> => {
    const [b0, y0] = pools();
    last = null;
    const out = await f();
    const r = last as EditResult | null;
    if (out === null || r === null || !out.ok) {
      problems.add(`${what}: refused (${out === null || r === null ? 'nothing posted' : out.ok ? '?' : out.why})`);
      return null;
    }
    const [b1, y1] = pools();
    batches.push({
      what, edits: n, editMs: round3(r.editMs), relightMs: round3(r.relightMs), subBatchMaxMs: round3(r.subBatchMaxMs), limboMax: r.limboMax,
      blockPoolBefore: b0, blockPoolAfter: b1, bytePoolBefore: y0, bytePoolAfter: y1,
    });
    return r;
  };
  const read = (b: Box, gen = false) => {
    const r = readVolume(store, b.x0, b.y0, b.z0, b.w, b.h, b.d, gen);
    if (r.values === null) throw new Error(`L3.paste: readVolume of (${b.x0}, ${b.y0}, ${b.z0}) ${b.w} × ${b.h} × ${b.d}: ${r.why}`);
    return r;
  };
  const light = (b: Box, what: string): number => {
    const t = now();
    const n = freshLightMismatches(store, colsOf(b), report, what);
    compareMs += now() - t;
    return n;
  };
  /** `referenceLight` over `b` grown by 16 on each side, compared on `b`'s footprint at every y. */
  const reference = (b: Box, what: string): number => {
    const t = now();
    referenceBoxes++;
    const x0 = b.x0 - 16;
    const z0 = b.z0 - 16;
    const w = b.w + 32;
    const h = b.d + 32;
    const ref = referenceLight({ x0, z0, w, h }, (x, y, z) => store.blockAt(x, y, z), (x, y, z) => store.fluidAt(x, y, z));
    let n = 0;
    for (let z = b.z0; z < b.z0 + b.d; z++) {
      for (let x = b.x0; x < b.x0 + b.w; x++) {
        for (let y = -64; y < 320; y++) {
          const got = store.lightAt(x, y, z);
          const want = ref[((y + 64) * h + (z - z0)) * w + (x - x0)]!;
          if (got === want) continue;
          n++;
          problems.add(`${what}: (${x}, ${y}, ${z}) light ${got >> 4}/${got & 15} ≠ referenceLight ${want >> 4}/${want & 15} (sky/block)`);
        }
      }
    }
    referenceMs += now() - t;
    return n;
  };
  /** The step's undo through the history: the box back to `before`, and its light. */
  const undo = async (b: Box, before: Uint32Array, what: string): Promise<void> => {
    const size = history.size;
    const n = history.snapshot().done.at(-1)?.edits.length ?? 0;
    const r = await run(`${what}: undo`, async () => {
      history.undo();
      // The undo's post runs inside `undo`; its outcome is recorded in the microtasks after it.
      await new Promise((resolve) => setImmediate(resolve));
      const l = last as EditResult | null;
      if (l === null) return null;
      return l.refused !== null ? { ok: false, why: l.refused } : { ok: true, prev: l.prev, next: l.next };
    }, n);
    if (r === null) return;
    if (history.size !== size - 1) problems.add(`${what}: the undo left ${history.size} steps (${size - 1} expected)`);
    pasteValueMismatches += cellDiffs(b, read(b).values!, (_x, _y, _z, i) => before[i]!, problems, `${what}: undone`);
    pasteLightMismatches += light(b, `${what}: undone`);
  };

  /** The usable blocks along an axis: the inner 6 columns, so every touched column's 3 × 3 has its own 3 × 3. */
  const lo = (c0: number): number => 16 * (c0 + 2);
  const hi = (c0: number): number => 16 * (c0 + L3_SIZE - 2);
  /** A min corner along an axis for a side of `size`: across a column border inside the usable blocks. */
  const across = (size: number, c0: number): number => {
    for (;;) {
      const b = 16 * (c0 + 3 + pick(L3_SIZE - 5));
      const v = size >= 2 ? b - 1 - pick(size - 1) : b - pick(2);
      if (v >= lo(c0) && v + size <= hi(c0)) return v;
    }
  };
  const regionTop = (b: Pick<Box, 'x0' | 'z0' | 'w' | 'd'>): number => {
    let top = -64;
    for (let z = b.z0; z < b.z0 + b.d; z++) for (let x = b.x0; x < b.x0 + b.w; x++) top = Math.max(top, store.heightAt('worldSurface', x, z)!);
    return top;
  };

  /** The boxes of the pastes not undone (the maximum paste goes above them). */
  const standing: Box[] = [];
  /** One paste of `clip` turned q at min corner (x0, y0, z0): built, applied, checked, and undone when `undoIt`. */
  const paste = async (clip: Clipboard, q: number, x0: number, y0: number, z0: number, what: string, o: { reference: boolean; undoIt: boolean; changes?: number }): Promise<void> => {
    const odd = (q & 1) === 1;
    const at: Box = { x0, y0, z0, w: odd ? clip.d : clip.w, h: clip.h, d: odd ? clip.w : clip.d };
    const before = read(at).values!;
    const edits = pasteBatch(clip, q, at, before);
    if (!Array.isArray(edits)) {
      problems.add(`${what}: refused by pasteBatch (${edits.why})`);
      return;
    }
    if (o.changes !== undefined && edits.length !== o.changes) problems.add(`${what}: ${edits.length} changes (${o.changes} expected)`);
    const r = await run(what, () => actionPost(edits), edits.length);
    if (r === null) return;
    if (r.limboMax > LIMBO_BOUND) {
      pasteLimboOver++;
      problems.add(`${what}: limboMax ${r.limboMax} > ${LIMBO_BOUND}`);
    }
    pasteValueMismatches += cellDiffs(at, read(at).values!, (x, y, z) => turnedCell(clip, q, x - at.x0, y - at.y0, z - at.z0), problems, what);
    pasteLightMismatches += light(at, what);
    if (o.reference) pasteLightMismatches += reference(at, `${what}: referenceLight`);
    if (o.undoIt) await undo(at, before, what);
    else standing.push(at);
  };

  for (let i = 0; i < L3_PASTES; i++) {
    const w = 1 + pick(32);
    const h = 1 + pick(32);
    const d = 1 + pick(32);
    const values = new Uint32Array(w * h * d);
    for (let k = 0; k < values.length; k++) values[k] = PALETTE[pick(PALETTE.length)]!;
    const q = pick(4);
    const odd = (q & 1) === 1;
    const tw = odd ? d : w;
    const td = odd ? w : d;
    const x0 = across(tw, cx0);
    const z0 = across(td, cz0);
    const s = store.heightAt('worldSurface', x0 + (tw >> 1), z0 + (td >> 1))!;
    const y0 = Math.max(-64, Math.min(320 - h, s + 2 - pick(h + 4)));
    await paste({ w, h, d, values }, q, x0, y0, z0, `seed 0x${L3_SEED.toString(16)} paste ${i} (${w} × ${h} × ${d}, ${q} turns)`, {
      reference: (i + 1) % L3_REFERENCE_EVERY === 0, undoIt: i % 2 === 1,
    });
  }

  // The maximum paste: the lit shells (32,768 changed) turned at random, into air across column borders.
  {
    const block = pasteLitBlock();
    const q = pick(4);
    const odd = (q & 1) === 1;
    const tw = odd ? block.d : block.w;
    const td = odd ? block.w : block.d;
    const x0 = across(tw, cx0);
    const z0 = across(td, cz0);
    const foot: Box = { x0, y0: 0, z0, w: tw, h: 1, d: td };
    const over = (b: Box): boolean => b.x0 < foot.x0 + foot.w && foot.x0 < b.x0 + b.w && b.z0 < foot.z0 + foot.d && foot.z0 < b.z0 + b.d;
    const y0 = Math.max(regionTop(foot) + 1, ...standing.filter(over).map((b) => b.y0 + b.h));
    if (y0 + block.h > 320) problems.add(`the maximum paste: its top ${y0 + block.h - 1} is above y 319`);
    await paste(block, q, x0, y0, z0, `seed 0x${L3_SEED.toString(16)} the maximum paste (${q} turns)`, { reference: true, undoIt: false, changes: 32_768 });
  }

  // The move: a 12 × 10 × 12 box across a column corner holding generated ground, turned once onto a target over it.
  {
    const what = `seed 0x${L3_SEED.toString(16)} the move`;
    const src: Box = { x0: 16 * (cx0 + 4) - 6, y0: 0, z0: 16 * (cz0 + 4) - 6, w: 12, h: 10, d: 12 };
    // The generated surface (the pastes above may have raised `worldSurface`), so the source straddles generated ground.
    const s = store.heightAt('worldSurfaceWG', src.x0 + 6, src.z0 + 6)!;
    const box: Box = { ...src, y0: Math.max(-64, s - 5) };
    const at: Box = { x0: box.x0 + 6, y0: box.y0 + 4, z0: box.z0 + 3, w: 12, h: 10, d: 12 };
    const all = union(box, at);
    const srcRead = read(box, true);
    const target = read(at).values!;
    const before = read(all).values!;
    let ground = 0;
    for (const v of srcRead.generated!) if (v >>> 8 !== AIR) ground++;
    if (ground === 0) problems.add(`${what}: the source holds no generated ground (surface ${s}, y0 ${box.y0}, ${srcRead.values!.filter((v) => v >>> 8 !== AIR).length} non-air now, gen[0] ${srcRead.generated![0]}, now[0] ${srcRead.values![0]})`);
    const edits = moveBatch(1, box, srcRead.values!, srcRead.generated!, at, target);
    if (!Array.isArray(edits)) {
      problems.add(`${what}: refused by moveBatch (${edits.why})`);
    } else {
      const r = await run(what, () => actionPost(edits), edits.length);
      if (r !== null) {
        // The generated terrain of the source's columns, from a fresh region of them.
        const gx0 = box.x0 >> 4;
        const gz0 = box.z0 >> 4;
        const ref = await genRegion({ seed: '42', params, cx0: gx0, cz0: gz0, w: ((box.x0 + box.w - 1) >> 4) - gx0 + 1, h: ((box.z0 + box.d - 1) >> 4) - gz0 + 1, upTo: 'D', order: 'spiral', threads: 1 });
        const moved: Clipboard = { w: box.w, h: box.h, d: box.d, values: srcRead.values! };
        pasteValueMismatches += cellDiffs(all, read(all).values!, (x, y, z, i) => {
          if (inBox(at, x, y, z)) return turnedCell(moved, 1, x - at.x0, y - at.y0, z - at.z0);
          if (inBox(box, x, y, z)) return val(ref.view.block(x, y, z), ref.view.fluid(x, y, z));
          return before[i]!;
        }, problems, what);
        pasteLightMismatches += light(all, what);
        await undo(all, before, what);
      }
    }
  }

  return {
    problems: problems.list,
    batches,
    values: {
      pasteValueMismatches,
      pasteLightMismatches,
      pasteLimboOver,
      pastes: L3_PASTES + 1,
      batches: batches.length,
      referenceBoxes,
      limboMaxMax: Math.max(0, ...batches.map((b) => b.limboMax)),
      editMsMax: Math.max(0, ...batches.map((b) => b.editMs)),
      subBatchMaxMsMax: Math.max(0, ...batches.map((b) => b.subBatchMaxMs)),
      blockPoolMiBBefore: round3((batches[0]?.blockPoolBefore ?? 0) / 1048576),
      blockPoolMiBAfter: round3((batches.at(-1)?.blockPoolAfter ?? 0) / 1048576),
      bytePoolMiBBefore: round3((batches[0]?.bytePoolBefore ?? 0) / 1048576),
      bytePoolMiBAfter: round3((batches.at(-1)?.bytePoolAfter ?? 0) / 1048576),
      compareSeconds: round3(compareMs / 1000),
      referenceSeconds: round3(referenceMs / 1000),
      genSeconds: round3(genSeconds),
      seconds: round3((now() - t0) / 1000),
    },
  };
}

// ---------------------------------------------------------------- the worlds (E3.paste, E5.paste)

/** A new world in `kv` as the menu's Create writes it, seed '42', flying at seed 42's spawn column (0, 0). */
async function createWorld(kv: MemoryKV, id: string, stateTable?: string[]): Promise<WorldRecord> {
  const session = openMapSession({ ...DEFAULT_MAP_STATE, seed: '42', profile: 'default' }, () => [1, 2]);
  const made = newWorldRecord(id, `World ${id}`, session.state, 1_700_000_000_000);
  const world = stateTable === undefined ? made : { ...made, stateTable };
  const state = { ...newState(id, STATE_BOUNDS), player: { x: 8.5, y: 120.25, z: 7.5, yaw: 0, pitch: -12.5, mode: 'fly' as const, speed: 12 } };
  const w = await createSaves(kv).create(world, state);
  if (w.status !== 'complete') throw new Error(`createWorld ${id}: ${w.status}`);
  return world;
}

/** A box's cells as the sim reads them now. */
async function cellsOf(p: PersistWorld, b: Box, gen = false): Promise<{ values: Uint32Array; generated: Uint32Array | null }> {
  const r = await p.copy(b, gen);
  if (r.values === null) throw new Error(`the copy of (${b.x0}, ${b.y0}, ${b.z0}) ${b.w} × ${b.h} × ${b.d} answered ${r.why}`);
  return { values: r.values, generated: r.generated };
}
/** The DiffStore entries of `cols` as one string. */
async function entriesOf(p: PersistWorld, cols: readonly number[]): Promise<string> {
  const ds = await p.settle(Promise.all(cols.map((k) => p.simClient.diff(colKeyCx(k), colKeyCz(k)))), 'the entries');
  return ds.map((d, i) => `${cols[i]}:${d === null ? '' : `${Array.from(d.sy).join(',')}|${Array.from(d.idx).join(',')}|${Array.from(d.value).join(',')}`}`).join(';');
}
/** The highest `worldSurface` over a footprint. */
function surfaceMax(store: VoxelStore, b: Pick<Box, 'x0' | 'z0' | 'w' | 'd'>): number {
  store.enterRead();
  try {
    let top = -64;
    for (let z = b.z0; z < b.z0 + b.d; z++) for (let x = b.x0; x < b.x0 + b.w; x++) top = Math.max(top, store.heightAt('worldSurface', x, z)!);
    return top;
  } finally {
    store.exitRead();
  }
}

/** Ctrl+V, the turns, the ghost pinned at (x0, y0, z0), RMB: `confirm`'s answer and the pasted box. */
async function pasteAt(p: PersistWorld, x0: number, y0: number, z0: number, turns: number, what: string): Promise<{ answer: string; box: Box | null }> {
  await p.settle(p.select.paste(), `${what}: Ctrl+V`);
  if (p.tool.mode !== 'place') return { answer: `not placing after Ctrl+V (${p.notices.at(-1) ?? 'no notice'})`, box: null };
  for (let i = 0; i < turns; i++) p.select.turn(1);
  p.select.placeAt(x0, y0, z0, true);
  const box = p.select.ghostState().box;
  const answer = await p.settle(p.select.confirm(), `${what}: RMB`);
  return { answer, box };
}
/** The corners on `src`, N, the ghost pinned at (x0, y0, z0), RMB. */
async function moveTo(p: PersistWorld, src: Box, x0: number, y0: number, z0: number, what: string): Promise<{ answer: string; box: Box | null }> {
  p.tool.placed(src);
  await p.settle(p.select.move(), `${what}: N`);
  if (p.tool.mode !== 'place') return { answer: `not placing after N (${p.notices.at(-1) ?? 'no notice'})`, box: null };
  p.select.placeAt(x0, y0, z0, true);
  const box = p.select.ghostState().box;
  const answer = await p.settle(p.select.confirm(), `${what}: RMB`);
  return { answer, box };
}
/** The corners on `b`, Ctrl+C: true when "Copied …" showed. */
async function copyBox(p: PersistWorld, b: Box, what: string): Promise<boolean> {
  p.tool.placed(b);
  const n = p.notices.length;
  await p.settle(p.select.copy(), `${what}: Ctrl+C`);
  return p.notices.slice(n).includes(`Copied ${b.w} × ${b.h} × ${b.d}`);
}
/** Ctrl+Z or Ctrl+Y, frames until its notice: the notices it showed. */
async function press(p: PersistWorld, op: 'undo' | 'redo', what: string): Promise<string[]> {
  const n = p.notices.length;
  if (op === 'undo') p.history.undo();
  else p.history.redo();
  await p.until(() => p.notices.length > n, `${what}: ${op}`);
  return p.notices.slice(n);
}
/** The distinct columns of `edits`, in first-edit order (the edit path's gate order, `editPath.ts` `post`). */
function stepColumns(edits: readonly { readonly x: number; readonly z: number }[]): Array<[number, number]> {
  const seen = new Set<string>();
  const out: Array<[number, number]> = [];
  for (const e of edits) {
    const k = `${e.x >> 4},${e.z >> 4}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push([e.x >> 4, e.z >> 4]);
  }
  return out;
}
/** The stored clipboard record. */
async function storedClipboard(clipKv: MemoryKV): Promise<unknown> {
  return (await clipKv.read([{ op: 'get', store: 'meta', key: CLIPBOARD_KEY }]))[0];
}

/** The house (7 × 6 × 7): its cells, index `(y · d + z) · w + x`, `state << 8 | fluid`. */
const HOUSE = (() => {
  const w = 7;
  const h = 6;
  const d = 7;
  const values = new Uint32Array(w * h * d);
  const at = (x: number, y: number, z: number, v: number): void => { values[(y * d + z) * w + x] = v; };
  const planks = val(stateOf('oak_planks'));
  for (let y = 0; y < h; y++) {
    for (let z = 0; z < d; z++) {
      for (let x = 0; x < w; x++) {
        const wallX = x === 0 || x === w - 1;
        const wallZ = z === 0 || z === d - 1;
        if (y === 0) at(x, y, z, planks);
        else if (y === h - 1) at(x, y, z, wallZ ? val(stateOf('oak_log[axis=x]')) : wallX ? val(stateOf('oak_log[axis=z]')) : planks);
        else if (wallX && wallZ) at(x, y, z, val(stateOf('oak_log[axis=y]')));
        else if (wallX || wallZ) at(x, y, z, y === 2 && (x === 3 || z === 3) ? val(stateOf('glass')) : planks);
      }
    }
  }
  // Wall torches against the four walls, facing into the room; ladders in the four facings, one more waterlogged.
  at(3, 3, 1, val(stateOf('wall_torch[facing=south]')));
  at(3, 3, 5, val(stateOf('wall_torch[facing=north]')));
  at(1, 3, 3, val(stateOf('wall_torch[facing=east]')));
  at(5, 3, 3, val(stateOf('wall_torch[facing=west]')));
  at(1, 1, 4, val(stateOf('ladder[facing=east]')));
  at(5, 1, 4, val(stateOf('ladder[facing=west]')));
  at(4, 1, 1, val(stateOf('ladder[facing=south]')));
  at(2, 1, 5, val(stateOf('ladder[facing=north]')));
  at(1, 2, 4, val(stateOf('ladder[facing=east]'), WATER_SOURCE));
  at(3, 1, 3, val(AIR, WATER_SOURCE));
  return { w, h, d, values } satisfies Clipboard;
})();

/** The 'T' changes of Review Focus 5 and 1 (the mode on): a large detail amplitude, then a smaller one. */
const RAISE: ParamsPatch = { density: { detailAmpLo: 8, detailAmpHi: 8 } };
const SETTLE: ParamsPatch = { density: { detailAmpLo: 4, detailAmpHi: 4 } };
/** Review Focus 5's candidate places for the house (min x, z), all inside columns −2 … 1 × −2 … −1. */
const RAISE_CANDIDATES: ReadonlyArray<[number, number]> = [[-20, -12], [-12, -28], [-4, -28], [12, -28]];

async function measureE3Paste(): Promise<{ values: Record<string, number>; problems: string[] }> {
  const t0 = now();
  const problems = problemList();
  const report = (s: string): void => problems.add(s);
  let pasteUndoMismatches = 0;
  let pasteRedoMismatches = 0;
  let clipboardReloadMismatches = 0;
  let pasteLeaveMismatches = 0;
  const kv = createMemoryKV();
  const clipKv = createMemoryKV();
  /** The `edits` replies' delay while set (the leave's maximum paste). */
  let slowEdits = false;
  const delayMs = (m: unknown): number => (slowEdits && (m as { type?: unknown }).type === 'edits' ? SLOW_MS : 0);
  await createWorld(kv, 'e3p');
  const open = (id: string): Promise<PersistWorld> => openPersistWorld({ kv, worldId: id, rd: RD, delayMs, clipKv });

  // The boxes (min corners; every one inside columns −2 … 1 so its 3 × 3s are loaded at RD 4, away from the pose).
  let houseA: Box;
  let pasteB: Box | null = null;
  let snapBefore: { cells: Uint32Array; entries: string };
  let snapAfter: { cells: Uint32Array; entries: string };
  let pastedB: Uint32Array;
  let clipBefore: unknown;
  /** Undo and redo of B, each against the state before and after its paste. */
  const undoRedo = async (p: PersistWorld, b: Box, what: string): Promise<void> => {
    const shell = grow(b);
    const cols = colsOf(shell);
    const said = await press(p, 'undo', `${what}: undo`);
    if (!said.includes('Undo · blocks')) {
      pasteUndoMismatches++;
      problems.add(`${what}: the undo said ${JSON.stringify(said)}`);
    }
    pasteUndoMismatches += cellDiffs(shell, (await cellsOf(p, shell)).values, (_x, _y, _z, i) => snapBefore.cells[i]!, problems, `${what}: undone`);
    if (await entriesOf(p, cols) !== snapBefore.entries) {
      pasteUndoMismatches++;
      problems.add(`${what}: undone: the DiffStore entries differ from before the paste`);
    }
    pasteUndoMismatches += freshLightMismatches(p.store, cols, report, `${what}: undone`);
    const again = await press(p, 'redo', `${what}: redo`);
    if (!again.includes('Redo · blocks')) {
      pasteRedoMismatches++;
      problems.add(`${what}: the redo said ${JSON.stringify(again)}`);
    }
    pasteRedoMismatches += cellDiffs(shell, (await cellsOf(p, shell)).values, (_x, _y, _z, i) => snapAfter.cells[i]!, problems, `${what}: redone`);
    if (await entriesOf(p, cols) !== snapAfter.entries) {
      pasteRedoMismatches++;
      problems.add(`${what}: redone: the DiffStore entries differ from after the paste`);
    }
    pasteRedoMismatches += freshLightMismatches(p.store, cols, report, `${what}: redone`);
  };

  // 1. The house built in air and copied; pasted across two column borders turned once; undone and redone three times.
  let p = await open('e3p');
  try {
    houseA = { x0: 20, y0: surfaceMax(p.store, { x0: 20, z0: -12, w: HOUSE.w, d: HOUSE.d }) + 1, z0: -12, w: HOUSE.w, h: HOUSE.h, d: HOUSE.d };
    const was = (await cellsOf(p, houseA)).values;
    const build: Edit[] = [];
    eachCell(houseA, (x, y, z, i) => {
      const v = HOUSE.values[i]!;
      if (v !== was[i]) build.push({ x, y, z, op: 'set', value: v, expect: was[i]! });
    });
    const built = await p.edit(build);
    if (!built.ok) throw new Error(`E3.paste: the house was not built (${built.why})`);
    if (!await copyBox(p, houseA, 'E3.paste: the house')) problems.add(`E3.paste: the house's copy said ${JSON.stringify(p.notices.slice(-3))}`);
    clipBefore = await storedClipboard(clipKv);
    const at = { x0: 13, z0: 13 };
    const y0 = surfaceMax(p.store, { ...at, w: HOUSE.d, d: HOUSE.w }) + 1;
    const shell = grow({ x0: at.x0, y0, z0: at.z0, w: HOUSE.d, h: HOUSE.h, d: HOUSE.w });
    snapBefore = { cells: (await cellsOf(p, shell)).values, entries: await entriesOf(p, colsOf(shell)) };
    const r = await pasteAt(p, at.x0, y0, at.z0, 1, 'E3.paste: the house turned once');
    if (r.answer !== 'ok' || r.box === null) throw new Error(`E3.paste: the house's paste answered '${r.answer}'`);
    pasteB = r.box;
    pasteRedoMismatches += cellDiffs(pasteB, (await cellsOf(p, pasteB)).values, (x, y, z) => turnedCell(HOUSE, 1, x - pasteB!.x0, y - pasteB!.y0, z - pasteB!.z0), problems, 'E3.paste: the house turned once');
    snapAfter = { cells: (await cellsOf(p, shell)).values, entries: await entriesOf(p, colsOf(shell)) };
    pastedB = (await cellsOf(p, pasteB)).values;
    for (let k = 0; k < 3; k++) await undoRedo(p, pasteB, `E3.paste: the house's paste, round ${k + 1}`);
    const f = await p.flushNow();
    if (!f.ok) problems.add('E3.paste: the flush did not commit');
  } finally {
    p.dispose();
  }

  // 2. A second world whose stored state table is today's reversed pastes the same clipboard, equal by state key.
  await createWorld(kv, 'e3q', todayStateTable().slice().reverse());
  let q = await openPersistWorld({ kv, worldId: 'e3q', rd: RD, clipKv });
  let qBox: Box | null = null;
  const byKey = (b: Box, got: Uint32Array, what: string): number => {
    let n = 0;
    eachCell(b, (x, y, z, i) => {
      const want = keyOf(HOUSE.values[i]!);
      if (keyOf(got[i]!) === want) return;
      n++;
      problems.add(`${what}: (${x}, ${y}, ${z}) is ${keyOf(got[i]!)} ≠ ${want}`);
    });
    return n;
  };
  try {
    const y0 = surfaceMax(q.store, { x0: 13, z0: 13, w: HOUSE.w, d: HOUSE.d }) + 1;
    const r = await pasteAt(q, 13, y0, 13, 0, 'E3.paste: the second world');
    if (r.answer !== 'ok' || r.box === null) {
      clipboardReloadMismatches++;
      problems.add(`E3.paste: the second world's paste answered '${r.answer}'`);
    } else {
      qBox = r.box;
      clipboardReloadMismatches += byKey(qBox, (await cellsOf(q, qBox)).values, 'E3.paste: the second world');
    }
    await q.flushNow();
  } finally {
    q.dispose();
  }
  q = await openPersistWorld({ kv, worldId: 'e3q', rd: RD, clipKv });
  try {
    if (qBox !== null) clipboardReloadMismatches += byKey(qBox, (await cellsOf(q, qBox)).values, 'E3.paste: the second world reopened');
  } finally {
    q.dispose();
  }

  // 3. Reopened: undo and redo again; the clipboard as before the reload, its paste equal; a move 3 down, undone.
  let backupId: string | null = null;
  /** Review Focus 1's refusal: 1 when it said `regenerating`, 0 when `not loaded` (recorded). */
  let rf1Gate = -1;
  /** Review Focus 5's target cells of generated ground (recorded). */
  let rf5Ground = 0;
  let houseE: Box | null = null;
  let beforeE: Uint32Array | null = null;
  p = await open('e3p');
  try {
    await undoRedo(p, pasteB!, 'E3.paste: the house\'s paste after the reload');
    const clipAfter = await storedClipboard(clipKv);
    const dec = decodeClipboard(clipAfter);
    if (!isDeepStrictEqual(clipAfter, clipBefore) || clipAfter === undefined || !dec.ok || dec.w !== HOUSE.w || dec.h !== HOUSE.h || dec.d !== HOUSE.d
      || dec.values.some((v, i) => v !== HOUSE.values[i])) {
      clipboardReloadMismatches++;
      problems.add('E3.paste: the clipboard after the reload is not the house as copied (record, sizes or cells)');
    }
    const cAt = { x0: -20, z0: 13 };
    const cy = surfaceMax(p.store, { ...cAt, w: HOUSE.d, d: HOUSE.w }) + 1;
    const c = await pasteAt(p, cAt.x0, cy, cAt.z0, 1, 'E3.paste: the clipboard after the reload');
    if (c.answer !== 'ok' || c.box === null) {
      clipboardReloadMismatches++;
      problems.add(`E3.paste: the paste after the reload answered '${c.answer}'`);
    } else {
      const got = (await cellsOf(p, c.box)).values;
      clipboardReloadMismatches += cellDiffs(c.box, got, (_x, _y, _z, i) => pastedB[i]!, problems, 'E3.paste: the paste after the reload against the one before');
      // The move 3 down (overlapping its source), undone: both boxes and the shell as before.
      const src = c.box;
      const all = grow(union(src, { ...src, y0: src.y0 - 3 }));
      const beforeMove = (await cellsOf(p, all)).values;
      const m = await moveTo(p, src, src.x0, src.y0 - 3, src.z0, 'E3.paste: the move 3 down');
      if (m.answer !== 'ok' || m.box === null) {
        pasteRedoMismatches++;
        problems.add(`E3.paste: the move 3 down answered '${m.answer}'`);
      } else {
        const tgt = m.box;
        // The target the source as read; the source cells it does not cover back to the generated terrain.
        const after = await cellsOf(p, all, true);
        pasteRedoMismatches += cellDiffs(all, after.values, (x, y, z, i) => {
          if (inBox(tgt, x, y, z)) return got[((y - src.y0 + 3) * src.d + (z - src.z0)) * src.w + (x - src.x0)]!;
          if (inBox(src, x, y, z)) return after.generated![i]!;
          return beforeMove[i]!;
        }, problems, 'E3.paste: the move 3 down');
        const said = await press(p, 'undo', 'E3.paste: the move 3 down: undo');
        if (!said.includes('Undo · blocks')) {
          pasteUndoMismatches++;
          problems.add(`E3.paste: the move's undo said ${JSON.stringify(said)}`);
        }
        pasteUndoMismatches += cellDiffs(all, (await cellsOf(p, all)).values, (_x, _y, _z, i) => beforeMove[i]!, problems, 'E3.paste: the move 3 down undone');
        pasteUndoMismatches += freshLightMismatches(p.store, colsOf(all), report, 'E3.paste: the move 3 down undone');
      }
    }

    // 4. Review Focus 5: the house where at least 40 target cells hold generated ground, at the place a 'T' change
    // raises most (predicted by a region of the new parameters).
    const next = applyPatch(SCHEMA, resolveProfile('default'), RAISE);
    if (!next.ok) throw new Error('E3.paste: the raised parameters');
    const ref = await genRegion({ seed: '42', params: next.value, cx0: -2, cz0: -2, w: 4, h: 2, upTo: 'D', order: 'spiral', threads: 1 });
    const topOf = (block: (x: number, y: number, z: number) => number, x: number, z: number): number => {
      for (let y = 319; y > -64; y--) if (block(x, y, z) !== AIR) return y;
      return -64;
    };
    let best: { x0: number; z0: number; rise: number } | null = null;
    p.store.enterRead();
    try {
      for (const [x0, z0] of RAISE_CANDIDATES) {
        let rise = 0;
        for (let z = z0; z < z0 + HOUSE.d; z++) {
          for (let x = x0; x < x0 + HOUSE.w; x++) rise += topOf((a, b, c) => ref.view.block(a, b, c), x, z) - topOf((a, b, c) => p.store.blockAt(a, b, c), x, z);
        }
        if (best === null || rise > best.rise) best = { x0, z0, rise };
      }
    } finally {
      p.store.exitRead();
    }
    if (best === null || best.rise <= 0) problems.add(`E3.paste: no candidate place where the change raises the surface (best ${JSON.stringify(best)})`);
    const ex = best!.x0;
    const ez = best!.z0;
    let ey = surfaceMax(p.store, { x0: ex, z0: ez, w: HOUSE.w, d: HOUSE.d }) + 1;
    let ground = 0;
    for (; ey > -60; ey--) {
      const v = (await cellsOf(p, { x0: ex, y0: ey, z0: ez, w: HOUSE.w, h: HOUSE.h, d: HOUSE.d })).values;
      ground = v.reduce((n, x) => n + (x >>> 8 !== AIR ? 1 : 0), 0);
      if (ground >= 40) break;
    }
    if (ground < 40) problems.add(`E3.paste: Review Focus 5's house: ${ground} target cells of generated ground (at least 40 expected)`);
    rf5Ground = ground;
    houseE = { x0: ex, y0: ey, z0: ez, w: HOUSE.w, h: HOUSE.h, d: HOUSE.d };
    beforeE = (await cellsOf(p, houseE)).values;
    const e = await pasteAt(p, ex, ey, ez, 0, 'E3.paste: Review Focus 5\'s house');
    if (e.answer !== 'ok') throw new Error(`E3.paste: Review Focus 5's house answered '${e.answer}'`);
    const stepE = p.history.snapshot().done.at(-1)!;

    // A box across the surface copied before the change.
    const fBox: Box = { x0: 24, y0: 0, z0: 0, w: 8, h: 10, d: 8 };
    const fAt: Box = { ...fBox, y0: Math.max(-64, surfaceMax(p.store, fBox) - 5) };
    if (!await copyBox(p, fAt, 'E3.paste: the box across the surface')) problems.add('E3.paste: the copy before the change did not show "Copied …"');
    const fCells = (await cellsOf(p, fAt)).values;

    // The mode on, the change: one backup posted and committed, its history ending with the house's step.
    p.modify(true);
    const raised = await p.change(RAISE);
    if (raised.from !== 'T' || !raised.backedUp || p.backups.length !== 1) {
      pasteUndoMismatches++;
      problems.add(`E3.paste: the raising change: from ${raised.from}, backed up ${raised.backedUp}, ${p.backups.length} backups (one expected)`);
    }
    const copies = kv.dump('worlds').map(([, v]) => v as WorldRecord).filter((w) => w.backupOf === 'e3p');
    backupId = copies[0]?.id ?? null;
    const backup = backupId === null ? null : await createSaves(kv).readAll(backupId);
    const lastStep = backup?.history?.done.at(-1);
    if (lastStep === undefined || canonicalJSON(lastStep.edits) !== canonicalJSON(stepE.edits)) {
      pasteUndoMismatches++;
      problems.add('E3.paste: the backup\'s history does not end with the house\'s step');
    }
    // Ctrl+Z: each cell of the step back to its before (a NO_ENTRY before: the new generated value); Ctrl+Y: its after.
    const stepCheck = async (step: BlockStep, side: 'before' | 'after', what: string): Promise<number> => {
      const b = houseE!;
      const r = await cellsOf(p, b, true);
      let n = 0;
      for (const ed of step.edits) {
        const i = ((ed.y - b.y0) * b.d + (ed.z - b.z0)) * b.w + (ed.x - b.x0);
        const want = ed[side] === NO_ENTRY ? r.generated![i]! : ed[side];
        if (r.values[i] === want) continue;
        n++;
        problems.add(`${what}: (${ed.x}, ${ed.y}, ${ed.z}) reads ${keyOf(r.values[i]!)} ≠ ${keyOf(want)}`);
      }
      return n;
    };
    let said = await press(p, 'undo', 'E3.paste: Review Focus 5: Ctrl+Z');
    if (!said.includes('Undo · blocks')) {
      pasteUndoMismatches++;
      problems.add(`E3.paste: Review Focus 5's undo said ${JSON.stringify(said)}`);
    }
    pasteUndoMismatches += await stepCheck(stepE, 'before', 'E3.paste: Review Focus 5 undone');
    said = await press(p, 'redo', 'E3.paste: Review Focus 5: Ctrl+Y');
    if (!said.includes('Redo · blocks')) {
      pasteRedoMismatches++;
      problems.add(`E3.paste: Review Focus 5's redo said ${JSON.stringify(said)}`);
    }
    pasteRedoMismatches += await stepCheck(stepE, 'after', 'E3.paste: Review Focus 5 redone');

    // The house the change left partly inside the ground, moved up 4 with one step; one undo restores both boxes.
    {
      const src = houseE;
      const srcNow = await cellsOf(p, src, true);
      let buried = 0;
      eachCell(src, (_x, _y, _z, i) => { if (srcNow.values[i] !== HOUSE.values[i] && srcNow.values[i]! >>> 8 !== AIR) buried++; });
      if (buried === 0) problems.add('E3.paste: the change left no new ground inside the house');
      const tgt: Box = { ...src, y0: src.y0 + 4 };
      const all = union(src, tgt);
      const beforeMove = (await cellsOf(p, all)).values;
      const m = await moveTo(p, src, tgt.x0, tgt.y0, tgt.z0, 'E3.paste: the buried house moved up');
      if (m.answer !== 'ok') {
        pasteRedoMismatches++;
        problems.add(`E3.paste: the buried house's move answered '${m.answer}'`);
      } else {
        const after = await cellsOf(p, all, true);
        pasteRedoMismatches += cellDiffs(all, after.values, (x, y, z, i) => {
          if (inBox(tgt, x, y, z)) return srcNow.values[((y - src.y0 - 4) * src.d + (z - src.z0)) * src.w + (x - src.x0)]!;
          if (inBox(src, x, y, z)) return after.generated![i]!;
          return beforeMove[i]!;
        }, problems, 'E3.paste: the buried house moved up');
        said = await press(p, 'undo', 'E3.paste: the buried house\'s move: undo');
        if (!said.includes('Undo · blocks')) {
          pasteUndoMismatches++;
          problems.add(`E3.paste: the buried house's undo said ${JSON.stringify(said)}`);
        }
        pasteUndoMismatches += cellDiffs(all, (await cellsOf(p, all)).values, (_x, _y, _z, i) => beforeMove[i]!, problems, 'E3.paste: the buried house\'s move undone');
      }
    }

    // The copy made before the change, pasted after it: every cell the copied value.
    {
      const dy = surfaceMax(p.store, { x0: 20, z0: 8, w: fAt.w, d: fAt.d }) - 4;
      const r = await pasteAt(p, 20, dy, 8, 0, 'E3.paste: the copy before the change pasted after it');
      if (r.answer !== 'ok' || r.box === null) {
        clipboardReloadMismatches++;
        problems.add(`E3.paste: the paste after the change answered '${r.answer}'`);
      } else {
        clipboardReloadMismatches += cellDiffs(r.box, (await cellsOf(p, r.box)).values, (_x, _y, _z, i) => fCells[i]!, problems, 'E3.paste: the copy before the change pasted after it');
      }
    }

    // Review Focus 1: a paste, then a 'T' change applied; Ctrl+Z while it regenerates is refused and keeps the step.
    {
      const gy = surfaceMax(p.store, { x0: -28, z0: -4, w: fAt.w, d: fAt.d }) - 4;
      const g = await pasteAt(p, -28, gy, -4, 0, 'E3.paste: Review Focus 1\'s paste');
      if (g.answer !== 'ok' || g.box === null) throw new Error(`E3.paste: Review Focus 1's paste answered '${g.answer}'`);
      const step = p.history.snapshot().done.at(-1)!;
      const size = p.history.size;
      const started = await p.change(SETTLE, { noWait: true });
      if (started.from !== 'T' || p.atApplied()) problems.add(`E3.paste: Review Focus 1's change: from ${started.from}, settled ${p.atApplied()}`);
      // The notice is the edit gate's (SP5a spec §2.1, :173 and :330; SP5c spec §2.7's table): over the step's distinct
      // columns, any `editState` 1 → `not loaded`, else any 2 → `regenerating` (`editPath.ts` `post`). During an Apply
      // a 3 × 3 reads 2 while every column of it is still stale, and 1 once the Apply's first update has freed one of
      // them (stale columns are freed nearest the camera first, `coordinator.ts` `apply`), until all nine are Published
      // at the new epoch (`coordinator.test.ts`' "2 until a column of its 3 × 3 is freed, then 1 …"). The gate is read
      // between frames, as the key is handled, so the expected notice is exact; it must be closed (not 0).
      let gate = 0;
      for (const [cx, cz] of stepColumns(step.edits)) {
        const s = p.editState(cx, cz);
        if (s === 1) {
          gate = 1;
          break;
        }
        if (s === 2) gate = 2;
      }
      const want = gate === 1 ? 'Can\'t undo there: not loaded' : 'Can\'t undo there: regenerating';
      said = await press(p, 'undo', 'E3.paste: Review Focus 1: Ctrl+Z while regenerating');
      rf1Gate = gate;
      if (gate === 0 || !said.includes(want) || said.some((t) => t.startsWith('Can\'t undo there') && t !== want) || p.history.size !== size) {
        pasteUndoMismatches++;
        problems.add(`E3.paste: Ctrl+Z while regenerating (gate ${gate}) said ${JSON.stringify(said)} (${JSON.stringify(want)} expected), ${p.history.size} steps (${size} kept expected)`);
      }
      await p.until(() => p.atApplied(), 'E3.paste: Review Focus 1: the world settled');
      said = await press(p, 'undo', 'E3.paste: Review Focus 1: Ctrl+Z after the change');
      if (!said.includes('Undo · blocks')) {
        pasteUndoMismatches++;
        problems.add(`E3.paste: Review Focus 1's undo after the change said ${JSON.stringify(said)}`);
      }
      const b = g.box;
      const r = await cellsOf(p, b, true);
      for (const ed of step.edits) {
        const i = ((ed.y - b.y0) * b.d + (ed.z - b.z0)) * b.w + (ed.x - b.x0);
        const want = ed.before === NO_ENTRY ? r.generated![i]! : ed.before;
        if (r.values[i] === want) continue;
        pasteUndoMismatches++;
        problems.add(`E3.paste: Review Focus 1 undone: (${ed.x}, ${ed.y}, ${ed.z}) reads ${keyOf(r.values[i]!)} ≠ ${keyOf(want)}`);
      }
    }

    // Last on this world (rulings P10): a cut whose clipboard write never settles cuts nothing.
    {
      const box = houseA;
      p.tool.placed(box);
      const cells = (await cellsOf(p, box)).values;
      const edits0 = p.posted('edits');
      const size = p.history.size;
      const writes = p.clipboardWrites;
      clipKv.crashNext();
      void p.select.cut().catch(() => {});
      await p.until(() => p.clipboardWrites > writes, 'E3.paste: the crashed cut\'s clipboard write');
      let frames = 0;
      await p.until(() => ++frames >= 50, 'E3.paste: 50 frames after the crashed write');
      const still = (await cellsOf(p, box)).values;
      const changed = cellDiffs(box, still, (_x, _y, _z, i) => cells[i]!, problems, 'E3.paste: the crashed cut');
      if (p.posted('edits') !== edits0 || p.history.size !== size || changed > 0) {
        clipboardReloadMismatches += Math.max(1, changed);
        problems.add(`E3.paste: the crashed cut: ${p.posted('edits') - edits0} edits posted, ${p.history.size - size} steps added, ${changed} cells changed (none expected)`);
      }
    }
  } finally {
    p.dispose();
  }

  // 5. The leave: a maximum paste with its reply delayed past the leave's 1,000 ms, `leave()` while it is pending.
  const block = pasteMaxBlock();
  const leaveAt = { x0: -24, z0: -8 };
  let leaveBox: Box | null = null;
  let leaveSteps = 0;
  p = await open('e3p');
  try {
    const w = await createClipboardStore({ kv: async () => clipKv, notices: { show() {} } }).write(block);
    if (!w.ok) throw new Error('E3.paste: the maximum block was not kept');
    const y0 = surfaceMax(p.store, { ...leaveAt, w: block.w, d: block.d }) + 1;
    await p.settle(p.select.paste(), 'E3.paste: the leave: Ctrl+V');
    p.select.placeAt(leaveAt.x0, y0, leaveAt.z0, true);
    leaveBox = p.select.ghostState().box;
    leaveSteps = p.history.size;
    const edits0 = p.posted('edits');
    slowEdits = true;
    const confirm = p.select.confirm();
    await p.until(() => p.posted('edits') > edits0, 'E3.paste: the leave: the paste posted');
    slowEdits = false;
    if (!p.bulkPending()) problems.add('E3.paste: the leave: no bulk batch pending at the leave');
    const r = await p.leave();
    if (r === null || !r.ok) {
      pasteLeaveMismatches++;
      problems.add(`E3.paste: the leave's flush: ${r === null ? 'none in time' : `${r.status} ${r.errorName}`}`);
    }
    const answer = await confirm;
    if (answer !== 'ok') problems.add(`E3.paste: the leave's paste answered '${answer}'`);
  } finally {
    p.dispose();
  }
  let entries = 0;
  let decodeMs = 0;
  p = await open('e3p');
  try {
    entries = p.opened.loaded.entries;
    decodeMs = p.opened.loaded.decodeMs;
    if (leaveBox !== null) {
      pasteLeaveMismatches += cellDiffs(leaveBox, (await cellsOf(p, leaveBox)).values, (_x, _y, _z, i) => block.values[i]!, problems, 'E3.paste: after the leave');
    }
    const last = p.history.snapshot().done.at(-1);
    if (p.history.size !== leaveSteps + 1 || last === undefined || last.edits.length !== 32_768 || leaveBox === null
      || last.edits.some((e) => !inBox(leaveBox!, e.x, e.y, e.z))) {
      pasteLeaveMismatches++;
      problems.add(`E3.paste: after the leave the history holds ${p.history.size} steps, the last of ${last?.edits.length ?? 0} edits (${leaveSteps + 1} and 32,768 in the box expected)`);
    }
  } finally {
    p.dispose();
  }

  // 6. Review Focus 5's backup: its last step (the house's paste) undone gives the old parameters' terrain.
  if (backupId !== null && houseE !== null && beforeE !== null) {
    const c = await openPersistWorld({ kv, worldId: backupId, rd: RD, clipKv });
    try {
      const said = await press(c, 'undo', 'E3.paste: the backup: Ctrl+Z');
      if (!said.includes('Undo · blocks')) {
        pasteUndoMismatches++;
        problems.add(`E3.paste: the backup's undo said ${JSON.stringify(said)}`);
      }
      pasteUndoMismatches += cellDiffs(houseE, (await cellsOf(c, houseE)).values, (_x, _y, _z, i) => beforeE![i]!, problems, 'E3.paste: the backup undone');
    } finally {
      c.dispose();
    }
  } else {
    pasteUndoMismatches++;
    problems.add('E3.paste: no backup to open');
  }

  const big = measureBigHistory(problems);
  return {
    problems: problems.list,
    values: {
      pasteUndoMismatches, pasteRedoMismatches, clipboardReloadMismatches, pasteLeaveMismatches,
      rf1Gate,
      rf5GroundCells: rf5Ground,
      diffEntriesAfterPastes: entries,
      loadDecodeMs: round3(decodeMs),
      bigHistoryEdits: big.edits,
      bigHistoryRestoreMs: round3(big.restoreMs),
      bigHistoryFirstFlushCloneMs: round3(big.cloneMs),
      seconds: round3((now() - t0) / 1000),
    },
  };
}

/**
 * With a 65,536-edit history (two steps of 32,768): the open's normalise-and-restore (`normalizeHistory` of the stored
 * record, then the block history's `restore`) and the first flush's main-thread clone (`structuredClone` of the flush
 * message the page's autosave builds: its state and its whole history).
 */
function measureBigHistory(problems: Problems): { edits: number; restoreMs: number; cloneMs: number } {
  const step = (k: number): HistoryRecord['done'][number] => ({
    edits: Array.from({ length: 32_768 }, (_, i) => ({ x: (i & 31) + 64 * k, y: 70 + (i >> 10), z: (i >> 5) & 31, before: NO_VALUE, after: val(STONE) })),
  });
  const stored: HistoryRecord = structuredClone({ worldId: 'big', done: [step(0), step(1)], undone: [] });
  const t0 = now();
  const n = normalizeHistory(stored, 'big', null);
  const history = createBlockHistory({
    post: () => Promise.resolve({ ok: false, why: 'failed' }), read: () => 0, pending: () => false, settled: () => Promise.resolve(), notices: { show() {} },
  });
  history.restore(n.history.done, n.history.undone);
  const restoreMs = now() - t0;
  const edits = history.snapshot().done.reduce((a, s) => a + s.edits.length, 0);
  if (edits !== MAX_HISTORY_EDITS) problems.add(`E3.paste: the big history restored ${edits} edits (${MAX_HISTORY_EDITS} expected)`);
  const autosave = createPageAutosave({
    worldId: 'big',
    fly: { x: 8.5, y: 120.25, z: 7.5, yaw: 0, pitch: 0, mode: 'fly', speed: 12 },
    frame: { t: 0.3 },
    speedIndex: () => 0,
    storedTime: null,
    hotbar: () => newState('big', STATE_BOUNDS).hotbar,
    blockHistory: history,
    sim: { flush: () => Promise.reject(new Error('not posted')) },
    settled: () => Promise.resolve(),
    editsSince: () => 0,
    now: () => 1_700_000_000_000,
    clock: { now: () => 0, setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {} },
    events: { on: () => () => {}, hidden: () => false },
    onResult() {},
  });
  const built = autosave.build();
  const t1 = now();
  structuredClone({ type: 'flush', id: 1, state: built.state, history: built.history });
  const cloneMs = now() - t1;
  autosave.dispose();
  return { edits, restoreMs, cloneMs };
}

// ---------------------------------------------------------------- E5.paste

async function measureE5Paste(): Promise<{ values: Record<string, number>; problems: string[] }> {
  const t0 = now();
  const problems = problemList();
  const report = (s: string): void => problems.add(s);
  let pasteStale = 0;
  const kv = createMemoryKV();
  const clipKv = createMemoryKV();
  let slowEdits = false;
  const delayMs = (m: unknown): number => (slowEdits && (m as { type?: unknown }).type === 'edits' ? SLOW_MS : 0);
  await createWorld(kv, 'e5p');
  const block = pasteMaxBlock();
  const at = { x0: -24, z0: -8 };
  const p = await openPersistWorld({ kv, worldId: 'e5p', rd: RD, delayMs, clipKv });
  let pinnedFrames = 0;
  try {
    const w = await createClipboardStore({ kv: async () => clipKv, notices: { show() {} } }).write(block);
    if (!w.ok) throw new Error('E5.paste: the maximum block was not kept');
    const pasted: Box[] = [];
    const ring = (): number[] => around(pasted.flatMap(colsOf));
    const freed = (): boolean => ring().every((k) => !p.published(colKeyCx(k), colKeyCz(k)));
    const loaded = (): boolean => ring().every((k) => p.published(colKeyCx(k), colKeyCz(k)));
    const check = async (what: string): Promise<void> => {
      for (const b of pasted) pasteStale += cellDiffs(b, (await cellsOf(p, b)).values, (_x, _y, _z, i) => block.values[i]!, problems, what);
      pasteStale += freshLightMismatches(p.store, pasted.flatMap(colsOf), report, what);
    };
    const back = async (what: string): Promise<void> => {
      await p.until(() => !p.bulkPending() && freed() && p.filled(), `${what}: the teleport`);
      p.teleport(0, 0);
      await p.until(() => p.filled() && loaded(), `${what}: back`);
    };

    // A maximum paste across column borders; the teleport of 640 columns and back.
    const y0 = surfaceMax(p.store, { ...at, w: block.w, d: block.d }) + 1;
    const r = await pasteAt(p, at.x0, y0, at.z0, 0, 'E5.paste: the maximum paste');
    if (r.answer !== 'ok' || r.box === null) throw new Error(`E5.paste: the maximum paste answered '${r.answer}'`);
    pasted.push(r.box);
    p.teleport(TELEPORT, 0);
    await back('E5.paste: the maximum paste');
    await check('E5.paste: after the teleport and back');

    // Review Focus 1: a second maximum paste on top of the first, its reply delayed; 100 ms after its post, the teleport.
    const y1 = y0 + block.h;
    if (y1 + block.h > 320) throw new Error(`E5.paste: the second paste's top ${y1 + block.h - 1} is above y 319`);
    await p.settle(p.select.paste(), 'E5.paste: Review Focus 1: Ctrl+V');
    p.select.placeAt(at.x0, y1, at.z0, true);
    const box = p.select.ghostState().box!;
    const edits0 = p.posted('edits');
    slowEdits = true;
    let replied = false;
    const confirm = p.select.confirm().then((a) => { replied = true; return a; });
    await p.until(() => p.posted('edits') > edits0, 'E5.paste: Review Focus 1: the paste posted');
    slowEdits = false;
    const posted = now();
    await p.until(() => now() - posted >= 100, 'E5.paste: Review Focus 1: 100 ms');
    p.teleport(TELEPORT, 0);
    const lost = new Set<number>();
    const pinnedRing = around(colsOf(box));
    await p.until(() => {
      if (replied) return true;
      pinnedFrames++;
      for (const k of pinnedRing) {
        if (p.pinned(colKeyCx(k), colKeyCz(k)) && p.published(colKeyCx(k), colKeyCz(k))) continue;
        if (!lost.has(k)) problems.add(`E5.paste: Review Focus 1: column (${colKeyCx(k)}, ${colKeyCz(k)}) ${p.pinned(colKeyCx(k), colKeyCz(k)) ? 'freed' : 'unpinned'} before the reply`);
        lost.add(k);
      }
      return false;
    }, 'E5.paste: Review Focus 1: the reply');
    pasteStale += lost.size;
    if (await confirm !== 'ok') throw new Error('E5.paste: Review Focus 1\'s paste was not accepted');
    pasted.push(box);
    await back('E5.paste: Review Focus 1');
    await check('E5.paste: Review Focus 1 after the teleport and back');
  } finally {
    p.dispose();
  }
  return { problems: problems.list, values: { pasteStale, pinnedFrames, seconds: round3((now() - t0) / 1000) } };
}

// ---------------------------------------------------------------- the metrics

metricTest('L3', ['pasteValueMismatches', 'pasteLightMismatches', 'pasteLimboOver'], async () => {
  const m = await measureL3Paste();
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'L3.paste.batches.json'), `${JSON.stringify({ id: 'L3.paste', tier: process.env.METRICS_TIER ?? null, batches: m.batches }, null, 2)}\n`);
  expect.soft(m.problems, `L3.paste (tier ${TIER}, seed 0x${L3_SEED.toString(16)}): first ${PROBLEMS} problems`).toEqual([]);
  return m.values;
}, 600_000, { outName: 'L3.paste' });

metricTest('E3', ['pasteUndoMismatches', 'pasteRedoMismatches', 'clipboardReloadMismatches', 'pasteLeaveMismatches'], async () => {
  const m = await measureE3Paste();
  expect.soft(m.problems, `E3.paste (tier ${TIER}): first ${PROBLEMS} problems`).toEqual([]);
  return m.values;
}, 600_000, { outName: 'E3.paste' });

metricTest('E5', ['pasteStale'], async () => {
  const m = await measureE5Paste();
  expect.soft(m.problems, `E5.paste (tier ${TIER}): first ${PROBLEMS} problems`).toEqual([]);
  return m.values;
}, 600_000, { outName: 'E5.paste' });
