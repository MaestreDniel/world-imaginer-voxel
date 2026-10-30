import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { colKey, colKeyCx, colKeyCz } from '../../src/core/coords';
import { parseHex64, type Hash64 } from '../../src/core/hash';
import { canonicalJSON } from '../../src/core/params/canonical';
import { applyPatch } from '../../src/core/params/kit';
import { resolveProfile, type ProfileId } from '../../src/core/params/profiles';
import { SCHEMA } from '../../src/core/params/schema';
import { seedFromInput } from '../../src/core/seed';
import { findSpawn } from '../../src/gen/column/spawn';
import { createGenContext } from '../../src/gen/context';
import { centreSection, createLightScratch, DEFAULT_LIGHT_TABLES, lightRegion } from '../../src/light/initial';
import { decodeColumnDiff, DiffDecodeError, encodeColumnDiff, encodedSize, type FluidTick } from '../../src/persist/diffCodec';
import { STORES, type WriteOp } from '../../src/persist/kv';
import { createMemoryKV, type MemoryKV } from '../../src/persist/memory';
import {
  createSaves, DEFAULT_SPEED, DEFAULT_T, HISTORY_STEPS, loadParams, MAX_NAME, MAX_PLACES, newState, NO_VALUE, olderGenerator,
  todayStateTable, type HistoryRecord, type Place, type PlayerRecord, type StateRecord, type WorldDump, type WorldRecord,
} from '../../src/persist/saves';
import { readWiworld, wiworldHash, writeWiworld } from '../../src/persist/wiworld';
import { createDiffStore } from '../../src/sim/diffStore';
import { DEFAULT_MAP_STATE, openMapSession } from '../../src/ui/map/mapState';
import { STATE_BOUNDS } from '../../src/ui/world/stateBounds';
import { newWorldRecord, OLDER_GENERATOR_NOTICE } from '../../src/ui/world/worldPage';
import type { DiffMsg, Edit, EditedMsg, FlushedMsg, FromSim } from '../../src/workers/protocol';
import { createSimHandler, type SimHandler } from '../../src/workers/simHandler';
import { LAVA_SOURCE, NO_FLUID, WATER_SOURCE } from '../../src/world/blocks/fluid';
import { AIR, GLASS, ICE, REGISTRY, STONE, TORCH } from '../../src/world/blocks/index';
import type { ColumnDiff } from '../../src/world/store/api';
import { SECTIONS } from '../../src/world/store/columnTable';
import { copyLightRegion } from '../../src/world/store/padded';
import type { VoxelStore } from '../../src/world/store/store';
import { currentTier, metricTest } from '../harness/metric';
import { openPersistWorld, type PersistWorld } from '../harness/persistWorld';
import { genRegion } from '../harness/region';
import { testRng } from '../harness/stats';

/**
 * E1-E7 and E5's flush part (SP5b spec §6.1, D28; master §6.4), every part `max 0` from SP5b, exact. Seeded with
 * `testRng`; every problem names its seed and case. The worlds are opened in process on the real stack through
 * `openPersistWorld` (`test/harness/persistWorld.ts`: §3.4's open, the page's edit path, block history, hotbar, places,
 * apply control with the modification mode, and autosave, over a `MemoryKV`), at RD 4, with seed 42's spawn column
 * (0, 0) as the centre.
 *
 * - **E1** (the codec, no world): 10,000 random columns (1,000 on the fast tier), each holding 1-3 sections at random
 *   `sy` (every `sy` 0-23 drawn over the run), each section's count from {1, 2559, 2560, 4096}, state ids ≥ 256, fluid 0
 *   and 127, trailers of 0, 1 and 40 ticks with `packedPos` near 2^32 − 1. `roundTripFailures`: decode(encode(d)) ≠ d
 *   (entries, genKey, ticks), or, on every 10th column, a DiffStore rebuilt from the decoded column (`setColumn`) reading
 *   differently from one filled entry by entry. `canonicalFailures`: encode(decode(b)) ≠ b; the bytes of the same column
 *   in a shuffled order (entries and ticks) ≠ b; the size ≠ `encodedSize` (the format's arithmetic); not every `sy`
 *   drawn; a case of the committed fixture `test/fixtures/columnDiffV1.json` not encoding to its hex. `rejectFailures`:
 *   one malformed case of §2.2 per column, the cases in turn (a bad `v` or `fmt`, more than 24 sections, `sy` ≥ 24,
 *   sections out of order, n = 0, a sparse n ≥ 2560, a dense popcount ≠ n, a dense n < 2560, a non-zero unmasked voxel,
 *   `idx` ≥ 4096, entries or ticks out of order, a state ≥ the stored table's length, a fluid byte of 255 or 128, a
 *   short or an over-long buffer; a case the column cannot carry passes to the next), decoded without a
 *   `DiffDecodeError`.
 * - **E2** (`.wiworld`): an amplified world with 20 edits of every kind, one of them undone (history on both sides),
 *   two places and a walking player is exported from its last committed save (`readAll`, `writeWiworld`) and imported
 *   into another KV under a new id (`readWiworld`, `writeAll`, as the menu's Import). `roundTripMismatches`: any saved
 *   part different except `id` and `updated` (the record, the state, the history, every column's bytes), `wiworldHash`
 *   different; a file with an undecodable column not imported with it skipped and counted; a D15 reject (not gzip, a bad
 *   magic, another `format`, version 2, a record past the end) not refused with its reason, or writing anything; and
 *   each `state` and `history` field §2.1's normaliser handles (an out-of-range speed, a bad mode, `t`, `speedIndex`, a
 *   place's colour, a long name, 300 places, a step outside the world, one with an unknown state, 120 steps) not read as
 *   its rule says. `regionHashMismatches`: `genRegion`'s upTo 'L' 7 × 7 window around the world's centre with the
 *   imported columns as its `diff` (`litRegionHash`) against the source world's window.
 * - **E3** (reload): a world opened with a walking player at `t` 0.3, its hotbar's slot 3 active and two places; 50
 *   edits of `test/integration/edit.test.ts`'s mix (stone, glass, ice, torch, wall torch, ladder, waterlogged ladder,
 *   water, lava, breaks; every 4th on a column border); `flushNow`; disposed (coordinator, pool and sim); reopened from
 *   the same KV. `reloadHashMismatches`: the 7 × 7 window's `litRegionHash` against before, and each edited voxel against
 *   its latest value. `reloadStateMismatches`: the opened world not at its stored pose, time, slot and places; the pose,
 *   mode, speed, time, hotbar, slot, history and places after the reload against before. Then the second case: the last
 *   step's voxel edited again with its reply delayed 40 ms past a flush posted at once (the hide trigger's), the world
 *   reopened, and every step undone: exactly one "the blocks changed" refusal (the stale step dropped, D32) and 49
 *   undone, every older step's voxel back to its value before the step, the stale voxel at its newest value.
 * - **E4** (aborted flush; KV-level reopens, at the sim's level): the sim handler attached to a seed-42 `genRegion`
 *   region (10 × 10 columns at the spawn, upTo 'L', a shared store); 64 columns (the inner 8 × 8) edited, 4 of them with
 *   a dense section, flushed; all 64 edited again, a `record` and a history sent; then for every op index k of that
 *   flush (64 columns, the state, the history, the record) and at `'commit'`, `failAt(k)` and a flush.
 *   `abortedFlushInconsistent`: an abort answered ok, a KV not equal to the committed snapshot, a fresh handler's `load`
 *   whose DiffStore differs from it. `lostAfterRetry`: the next flush not committing the union with `flushSeq` + 1, or
 *   the aborted batch's history or record missing from it; an edit handled between a flush's encode and its completion
 *   missing from the next flush (after a completed flush and after an aborted one); a column whose entries were all
 *   reverted to the generated value keeping its key. `crashedFlushInconsistent`: after `crashNext()` and a flush that
 *   never settles, a fresh handler's `load` differing from the last committed snapshot, or the stored `flushSeq` moved.
 * - **E5's flush part** (`.out/E5.flush.json`): rounds (2 on the fast tier, 3 otherwise) of batches of 1-3 voxels, a
 *   completed flush, more batches, a flush posted and one more batch after it, the KV writing in 25 ms; the session torn
 *   down at a seeded point within that flush's window (half the rounds with the write crashed: it never commits), then
 *   reopened from the KV's committed state. `flushStale`: a voxel not at the value the committed flush holds (an edit
 *   before it not at its latest value, an edit after it present, a batch half applied). `flushLightMismatches`: each
 *   edited column's 3 × 3 against a fresh `lightRegion`.
 * - **E6** (redefined): with the mode on and no edits, a terrain change ('T') makes no copy; then edits (one placing the
 *   next terrain's own value where today's is air), a flush, and the next 'T' change makes exactly one copy whose record
 *   (but its id, name and `backupOf`), parameters, genKey, state (but `worldId` and `updated`, its `flushSeq` the
 *   original's of the same write), history and diff keys and bytes equal the original's just before the change, while
 *   the original continues under its id with the new parameters and genKey (after the next flush), every block at its
 *   coordinates, the one equal to the new terrain's value included and stored (`backupMissing`). A second change in that
 *   mode session, a change with the mode off, and `beforeApply` of 'L', 'MESH' and an adopt in a new mode session make
 *   no copy; the copy posted before the draft returned to the applied one is made and kept (`backupSpurious`). Then the
 *   stored genKey is made an older one and a column holding an entry equal to today's generated value is added under it:
 *   the open is flagged older with D8's notice once, today's terrain with every edit at its coordinates and that entry
 *   read and kept, no copy, and the next flush writes today's genKey, so the flag no longer holds (`olderGeneratorWrong`).
 * - **E7**: two worlds with the same genKey, each with its own pose, time, hotbar and places and its own edits.
 *   `crossWorldLeaks`: an edit of one read in the other (live, after a reopen) or stored in the other's `diffs` range,
 *   or a world's own edit not read back. `perWorldStateWrong`: the pose, time, hotbar, history or places of a world not
 *   as it saved them (the other's restored instead). `deleteLeftovers`: a key of the deleted world in any store, or a
 *   record of the other world gone. `remapMismatches`: copies of the first world stored under today's table reversed
 *   plus an unknown key (one entry under it) and under a strict prefix of today's table, each opened with every voxel
 *   equal by state key, the unknown entry air and counted, the history equal and today's table stored, its columns
 *   re-encoded under today's ids; then an edit with a state outside the stored table (the last of today's), a flush and
 *   a reopen: voxels and history equal, today's table stored.
 * - **Recorded, not gated** (`.out/persist.json`): `flushSyncP95Ms` over every committed flush of the run's worlds, the
 *   frames to the first fill with an empty and a heavy save on `MemoryKV` (every column of the RD 4 + 3 disc with 64
 *   sparse entries, 16 of them with a dense section), the heavy save's `decodeMs`, its backup's time, the DiffStore's
 *   heap estimate with it (D19, D26), and E1's own time.
 */
const TIER = currentTier();
const FAST = TIER === 'fast';
const RD = 4;
/** The problems listed per part. */
const PROBLEMS = 20;
const E1_COLUMNS = FAST ? 1000 : 10_000;
const E1_SEED = 0xe1;
const E5_ROUNDS = FAST ? 2 : 3;
const E5_WRITE_MS = 25;
const OUT_DIR = fileURLToPath(new URL('./.out/', import.meta.url));

const now = (): number => performance.now();
const val = (state: number, fluid = NO_FLUID): number => ((state << 8) | fluid) >>> 0;
const facings = (type: string): number[] => ['north', 'south', 'east', 'west'].map((f) => REGISTRY.parseStateKey(`${type}[facing=${f}]`));
const WALL_TORCHES = facings('wall_torch');
const LADDERS = facings('ladder');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const round3 = (x: number): number => Math.round(x * 1000) / 1000;

/** `syncMs` of every committed flush the run's worlds posted (`flushSyncP95Ms`). */
const syncMs: number[] = [];
/** E1's own time (spec §7: 1-3 s). */
let e1Seconds = 0;
/** The frames to the first fill of E5's world at its first open: an empty save (none when E5 did not run). */
let fillFramesEmpty: number | null = null;

function percentile(xs: readonly number[], p: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]!;
}

interface Problems {
  readonly list: string[];
  add(s: string): void;
}
/** A part's problems, the first `PROBLEMS` kept. */
function problemList(): Problems {
  const list: string[] = [];
  return { list, add: (s) => { if (list.length < PROBLEMS) list.push(s); } };
}

// ---------------------------------------------------------------- worlds

interface WorldInit {
  readonly profile?: ProfileId;
  readonly player?: PlayerRecord | null;
  readonly time?: { t: number; speedIndex: number };
  readonly active?: number;
  readonly places?: Place[];
}

/** A new world in `kv` as the menu's Create writes it (§1.2), seed '42': its record and its state, in one write. */
async function createWorld(kv: MemoryKV, id: string, init: WorldInit = {}): Promise<{ world: WorldRecord; state: StateRecord }> {
  const session = openMapSession({ ...DEFAULT_MAP_STATE, seed: '42', profile: init.profile ?? 'default' }, () => [1, 2]);
  const world = newWorldRecord(id, `World ${id}`, session.state, 1_700_000_000_000);
  const base = newState(id, STATE_BOUNDS);
  const state: StateRecord = {
    ...base,
    player: init.player ?? null,
    time: init.time ?? base.time,
    hotbar: { ...base.hotbar, active: init.active ?? base.hotbar.active },
    places: init.places ?? [],
  };
  const w = await createSaves(kv).create(world, state);
  if (w.status !== 'complete') throw new Error(`createWorld ${id}: ${w.status}`);
  return { world, state };
}

/** A pose in seed 42's spawn column (0, 0), so a world's window is the same at every open. */
const player = (mode: 'walk' | 'fly', yaw: number, speed: number): PlayerRecord => ({ x: 8.5, y: 120.25, z: 7.5, yaw, pitch: -12.5, mode, speed });
const place = (id: string, name: string, colour: number, x: number): Place => ({ id, name, colour, x, y: 90, z: -40.5, yaw: 90, pitch: 0 });

function valueAt(store: VoxelStore, x: number, y: number, z: number): number {
  store.enterRead();
  try {
    return val(store.blockAt(x, y, z), store.fluidAt(x, y, z));
  } finally {
    store.exitRead();
  }
}
function surfaceAt(store: VoxelStore, x: number, z: number): number {
  store.enterRead();
  try {
    return store.heightAt('worldSurface', x, z)!;
  } finally {
    store.exitRead();
  }
}

/** One edited voxel: its value before the run first edited it, and its latest accepted value. */
interface Edited {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly before: number;
  value: number;
}
const vkey = (x: number, y: number, z: number): string => `${x},${y},${z}`;

/** `test/integration/edit.test.ts`'s mix (its `KINDS`). */
const MIX: ReadonlyArray<(n: number) => number> = [
  () => val(STONE), () => val(GLASS), () => val(ICE), () => val(TORCH), (n) => val(WALL_TORCHES[n % 4]!),
  (n) => val(LADDERS[n % 4]!), (n) => val(LADDERS[(n + 1) % 4]!, WATER_SOURCE), () => val(AIR, WATER_SOURCE),
  () => val(AIR, LAVA_SOURCE), () => val(AIR),
];
/** E7's states: few and low, so a strict prefix of today's table holds them. */
const LOW: ReadonlyArray<(n: number) => number> = [() => val(STONE), () => val(GLASS), () => val(TORCH), () => val(AIR)];

/** A voxel for the next edit: into the first air above the surface (a break takes the surface block). */
function pickVoxel(p: PersistWorld, next: () => number, n: number, value: number, spread: number): { x: number; y: number; z: number } {
  const BORDER = [0, 15];
  const cx = p.centre.cx - spread + (next() % (2 * spread + 1));
  const cz = p.centre.cz - spread + (next() % (2 * spread + 1));
  const lx = n % 4 === 0 ? BORDER[next() % 2]! : next() % 16;
  const lz = n % 8 === 0 ? BORDER[next() % 2]! : next() % 16;
  const x = 16 * cx + lx;
  const z = 16 * cz + lz;
  const s = surfaceAt(p.store, x, z);
  return { x, y: Math.min(319, value === val(AIR) ? s - 1 : s), z };
}

/**
 * `n` single-voxel edits around the centre column (± `spread` columns), one at a time, every 4th on a column border,
 * none at a voxel in `edited` or `taken`; the accepted ones are added to `edited`.
 */
async function editMix(
  p: PersistWorld, n: number, next: () => number, edited: Map<string, Edited>, problems: Problems, what: string,
  o: { kinds?: ReadonlyArray<(n: number) => number>; taken?: ReadonlySet<string>; spread?: number } = {},
): Promise<void> {
  const kinds = o.kinds ?? MIX;
  for (let k = 0, posted = 0; posted < n && k < 50 * n; k++) {
    const value = kinds[posted % kinds.length]!(posted);
    const { x, y, z } = pickVoxel(p, next, posted, value, o.spread ?? 2);
    if (edited.has(vkey(x, y, z)) || o.taken?.has(vkey(x, y, z)) === true) continue;
    const was = valueAt(p.store, x, y, z);
    if (was === value) continue;
    posted++;
    const out = await p.edit([{ x, y, z, op: 'set', value, expect: was }]);
    if (!out.ok || out.next.length === 0) {
      problems.add(`${what}: the edit at (${x}, ${y}, ${z}) was refused (${out.ok ? 'nothing edited' : out.why})`);
      continue;
    }
    edited.set(vkey(x, y, z), { x, y, z, before: was, value });
  }
}

/** The voxels of `edited` not at `want(e)` (default: the latest value) in `store`, each a problem. */
function staleVoxels(store: VoxelStore, edited: Iterable<Edited>, problems: Problems, what: string, want: (e: Edited) => number = (e) => e.value): number {
  let n = 0;
  for (const e of edited) {
    const got = valueAt(store, e.x, e.y, e.z);
    const w = want(e);
    if (got === w) continue;
    n++;
    problems.add(`${what}: (${e.x}, ${e.y}, ${e.z}) reads ${got >> 8}/${got & 255} ≠ ${w >> 8}/${w & 255} (state/fluid)`);
  }
  return n;
}

const freshScratch = createLightScratch();
const bytesOf = (a: Uint8Array): Buffer => Buffer.from(a.buffer, a.byteOffset, a.byteLength);
const hexOf = (a: Uint8Array): string => bytesOf(a).toString('hex');
const uniform = (a: Uint8Array, v: number): boolean => {
  for (let i = 0; i < a.length; i++) if (a[i] !== v) return false;
  return true;
};

/** The voxels of the 3 × 3 around each of `cols` (colKeys) whose stored light differs from a fresh `lightRegion`. */
function lightMismatches(store: VoxelStore, cols: Iterable<number>, problems: Problems, what: string): number {
  const seen = new Set<number>();
  let n = 0;
  store.enterRead();
  try {
    for (const k of cols) {
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const cx = colKeyCx(k) + dx;
          const cz = colKeyCz(k) + dz;
          if (seen.has(colKey(cx, cz))) continue;
          seen.add(colKey(cx, cz));
          const f = store.final(cx, cz);
          if (f === null) {
            n += 4096 * SECTIONS;
            problems.add(`${what}: column (${cx}, ${cz}) has no final set`);
            continue;
          }
          copyLightRegion(store.neighborhood(cx, cz), freshScratch.region);
          lightRegion(freshScratch, DEFAULT_LIGHT_TABLES, true);
          for (let sy = 0; sy < SECTIONS; sy++) {
            const want = centreSection(freshScratch, sy);
            const stored = f.sectionLight(sy);
            if (typeof stored === 'number' ? uniform(want, stored) : bytesOf(stored).equals(bytesOf(want))) continue;
            for (let i = 0; i < 4096; i++) {
              if ((typeof stored === 'number' ? stored : stored[i]!) === want[i]) continue;
              n++;
              problems.add(`${what}: (${16 * cx + (i & 15)}, ${16 * sy - 64 + (i >> 8)}, ${16 * cz + ((i >> 4) & 15)}) light ≠ lightRegion`);
            }
          }
        }
      }
    }
  } finally {
    store.exitRead();
  }
  return n;
}

const colsOf = (edited: Iterable<Edited>): Set<number> => new Set([...edited].map((e) => colKey(e.x >> 4, e.z >> 4)));

/** `flushNow`, its `syncMs` recorded when it committed; its `flushSeq`, or −1 (a problem) when it did not. */
async function flush(p: PersistWorld, problems: Problems, what: string): Promise<number> {
  const r = await p.flushNow();
  if (!r.ok) {
    problems.add(`${what}: the flush did not commit (${r.status}, ${r.errorName})`);
    return -1;
  }
  syncMs.push(r.syncMs);
  return r.flushSeq;
}

const sameJson = (a: unknown, b: unknown): boolean => canonicalJSON(a) === canonicalJSON(b);

/** Every store of `kv` as canonical JSON, bytes as hex: one string to compare a snapshot with. */
function kvSnapshot(kv: MemoryKV): string {
  return canonicalJSON(Object.fromEntries(STORES.map((s) => [s, kv.dump(s).map(([k, v]) => [k, v instanceof Uint8Array ? hexOf(v) : v])])));
}

/** The `state` record of `id` in `kv`, as stored. */
const storedState = (kv: MemoryKV, id: string): StateRecord | undefined =>
  kv.dump('state').find(([k]) => k === id)?.[1] as StateRecord | undefined;
const storedWorld = (kv: MemoryKV, id: string): WorldRecord | undefined =>
  kv.dump('worlds').find(([k]) => k === id)?.[1] as WorldRecord | undefined;
/** World `id`'s stored columns, by colKey. */
function storedCols(kv: MemoryKV, id: string): Map<number, Uint8Array> {
  const out = new Map<number, Uint8Array>();
  for (const [k, v] of kv.dump('diffs')) if (Array.isArray(k) && k[0] === id) out.set(k[1] as number, v as Uint8Array);
  return out;
}

/** The state's restored parts, in the order spec §6.1 names them. */
function stateParts(s: StateRecord): Record<string, unknown> {
  return {
    pose: s.player === null ? null : { x: s.player.x, y: s.player.y, z: s.player.z, yaw: s.player.yaw, pitch: s.player.pitch },
    mode: s.player?.mode ?? null,
    speed: s.player?.speed ?? null,
    time: s.time,
    hotbar: s.hotbar.slots,
    slot: s.hotbar.active,
    places: s.places,
  };
}
/** The restored parts and the history's sides of `got` that differ from `want`, each a problem. */
function stateDiffs(
  got: { readonly state: StateRecord; readonly history: HistoryRecord }, want: { readonly state: StateRecord; readonly history: HistoryRecord },
  problems: Problems, what: string,
): number {
  let n = 0;
  const a = stateParts(got.state);
  const b = stateParts(want.state);
  for (const k of Object.keys(b)) {
    if (sameJson(a[k], b[k])) continue;
    n++;
    problems.add(`${what}: ${k} ${canonicalJSON(a[k]).slice(0, 100)} ≠ ${canonicalJSON(b[k]).slice(0, 100)}`);
  }
  if (!sameJson([got.history.done, got.history.undone], [want.history.done, want.history.undone])) {
    n++;
    problems.add(`${what}: the history (${got.history.done.length} done, ${got.history.undone.length} undone) ≠ (${want.history.done.length}, ${want.history.undone.length})`);
  }
  return n;
}

// ---------------------------------------------------------------- E1

interface Column {
  readonly diff: ColumnDiff;
  readonly genKey: Hash64;
  readonly ticks: readonly FluidTick[];
}
const COUNTS = [1, 2559, 2560, 4096] as const;
const TICK_COUNTS = [0, 1, 40] as const;
/** Every u16 state id decodes (the stored table's length; E1 has no world). */
const STATE_COUNT = 65536;

/** `k` distinct values of 0 … n − 1, ascending (a partial Fisher-Yates). */
function distinct(next: () => number, n: number, k: number): Uint16Array {
  const a = new Uint16Array(n);
  for (let i = 0; i < n; i++) a[i] = i;
  for (let i = 0; i < k; i++) {
    const j = i + (next() % (n - i));
    const t = a[i]!;
    a[i] = a[j]!;
    a[j] = t;
  }
  return a.slice(0, k).sort();
}

/** A random column in canonical order (spec §6.1 E1's shape); `sys` collects the drawn `sy`. */
function randomColumn(next: () => number, sys: Set<number>): Column {
  const secs = distinct(next, 24, 1 + (next() % 3));
  const counts = Array.from(secs, () => COUNTS[next() % COUNTS.length]!);
  const total = counts.reduce((a, b) => a + b, 0);
  const sy = new Uint8Array(total);
  const idx = new Uint16Array(total);
  const value = new Uint32Array(total);
  let k = 0;
  for (let s = 0; s < secs.length; s++) {
    sys.add(secs[s]!);
    for (const i of distinct(next, 4096, counts[s]!)) {
      sy[k] = secs[s]!;
      idx[k] = i;
      // One draw per entry: the state from its low bits, the fluid from its top bit.
      const r = next();
      value[k++] = ((256 + (r % (STATE_COUNT - 256))) << 8 | (r >>> 31 === 1 ? 127 : 0)) >>> 0;
    }
  }
  const pos = distinct(next, 1000, TICK_COUNTS[next() % TICK_COUNTS.length]!);
  return { diff: { sy, idx, value }, genKey: [next(), next()], ticks: Array.from(pos, (q) => ({ packedPos: 2 ** 32 - 1000 + q, dueOffset: next() & 0xFFFF })) };
}

/** The column's entries in a shuffled order (Fisher-Yates). */
function shuffledDiff(next: () => number, d: ColumnDiff): ColumnDiff {
  const n = d.sy.length;
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  for (let i = n - 1; i > 0; i--) {
    const j = next() % (i + 1);
    const t = order[i]!;
    order[i] = order[j]!;
    order[j] = t;
  }
  const sy = new Uint8Array(n);
  const idx = new Uint16Array(n);
  const value = new Uint32Array(n);
  for (let k = 0; k < n; k++) {
    sy[k] = d.sy[order[k]!]!;
    idx[k] = d.idx[order[k]!]!;
    value[k] = d.value[order[k]!]!;
  }
  return { sy, idx, value };
}

const sameArray = (a: ArrayLike<number>, b: ArrayLike<number>): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};
const sameDiff = (a: ColumnDiff, b: ColumnDiff): boolean => sameArray(a.sy, b.sy) && sameArray(a.idx, b.idx) && sameArray(a.value, b.value);

/** The sections of an encoded column (each one's offset, `sy`, `fmt` and `n`) and the trailer's offset. */
function layout(b: Uint8Array): { secs: Array<{ at: number; sy: number; fmt: number; n: number }>; trailer: number } {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const secs: Array<{ at: number; sy: number; fmt: number; n: number }> = [];
  let at = 10;
  for (let s = 0; s < b[9]!; s++) {
    const n = v.getUint16(at + 2, true);
    secs.push({ at, sy: b[at]!, fmt: b[at + 1]!, n });
    at += 4 + (n < 2560 ? 5 * n : 12800);
  }
  return { secs, trailer: at };
}

type Bad = { bytes: Uint8Array; stateCount: number } | null;
/** A copy of `b` changed by `f`, decoded against `stateCount`. */
const mutated = (b: Uint8Array, f: (x: Uint8Array) => void, stateCount = STATE_COUNT): Bad => {
  const x = b.slice();
  f(x);
  return { bytes: x, stateCount };
};
/** The first voxel of a dense section at `at` that its mask holds (`masked`) or not. */
const maskedVoxel = (b: Uint8Array, at: number, masked: boolean): number => {
  let i = 0;
  while (((b[at + 4 + (i >> 3)]! & (1 << (i & 7))) !== 0) !== masked) i++;
  return i;
};

/**
 * The malformed cases of §2.2 (spec §6.1 E1 `rejectFailures`), each made from a valid encoded column, or null when the
 * column cannot carry it.
 */
const REJECTS: ReadonlyArray<{ readonly name: string; make(b: Uint8Array, c: Column): Bad }> = [
  { name: 'v 2', make: (b) => mutated(b, (x) => { x[0] = 2; }) },
  { name: 'fmt 2', make: (b) => mutated(b, (x) => { x[11] = 2; }) },
  { name: 'more than 24 sections', make: (b) => mutated(b, (x) => { x[9] = 25; }) },
  { name: 'sy 24', make: (b) => mutated(b, (x) => { x[layout(b).secs.at(-1)!.at] = 24; }) },
  {
    name: 'sections out of order',
    make: (b) => {
      const { secs } = layout(b);
      return secs.length < 2 ? null : mutated(b, (x) => { x[secs[1]!.at] = secs[0]!.sy; });
    },
  },
  { name: 'n 0', make: (b) => mutated(b, (x) => { x[12] = 0; x[13] = 0; }) },
  {
    name: 'a sparse section with n ≥ 2560',
    make: (b) => {
      const s = layout(b).secs.find((q) => q.fmt === 1);
      return s === undefined ? null : mutated(b, (x) => { x[s.at + 1] = 0; });
    },
  },
  {
    name: 'a dense mask popcount ≠ n',
    make: (b) => {
      const s = layout(b).secs.find((q) => q.fmt === 1);
      return s === undefined ? null : mutated(b, (x) => { x[s.at + 4] = x[s.at + 4]! ^ 0x01; });
    },
  },
  {
    name: 'a dense section with n < 2560',
    make: (b) => {
      const s = layout(b).secs.find((q) => q.fmt === 0);
      return s === undefined ? null : mutated(b, (x) => { x[s.at + 1] = 1; });
    },
  },
  {
    name: 'a non-zero unmasked voxel',
    make: (b) => {
      const s = layout(b).secs.find((q) => q.fmt === 1 && q.n < 4096);
      return s === undefined ? null : mutated(b, (x) => { x[s.at + 4 + 512 + 2 * maskedVoxel(b, s.at, false)] = 1; });
    },
  },
  {
    name: 'idx ≥ 4096',
    make: (b) => {
      const s = layout(b).secs.find((q) => q.fmt === 0);
      return s === undefined ? null : mutated(b, (x) => { x[s.at + 4 + 5 * (s.n - 1)] = 0x00; x[s.at + 4 + 5 * (s.n - 1) + 1] = 0x10; });
    },
  },
  {
    name: 'entries out of order',
    make: (b) => {
      const s = layout(b).secs.find((q) => q.fmt === 0 && q.n >= 2);
      return s === undefined ? null : mutated(b, (x) => { x.copyWithin(s.at + 4 + 5, s.at + 4, s.at + 6); });
    },
  },
  {
    name: 'ticks out of order',
    make: (b, c) => {
      const t = layout(b).trailer + 2;
      return c.ticks.length < 2 ? null : mutated(b, (x) => { x.copyWithin(t + 6, t, t + 4); });
    },
  },
  {
    name: 'a state ≥ the stored table\'s length',
    make: (b, c) => {
      let max = 0;
      for (const v of c.diff.value) max = Math.max(max, v >>> 8);
      return { bytes: b, stateCount: max };
    },
  },
  {
    name: 'fluid 255',
    make: (b) => {
      const s = layout(b).secs[0]!;
      return mutated(b, (x) => {
        if (s.fmt === 0) x[s.at + 4 + 4] = 255;
        else x[s.at + 4 + 512 + 8192 + maskedVoxel(b, s.at, true)] = 255;
      });
    },
  },
  {
    name: 'fluid 128',
    make: (b) => {
      const s = layout(b).secs[0]!;
      return s.fmt !== 0 ? null : mutated(b, (x) => { x[s.at + 4 + 4] = 128; });
    },
  },
  { name: 'short', make: (b, c) => ({ bytes: b.slice(0, (c.genKey[0] >>> 0) % b.length), stateCount: STATE_COUNT }) },
  { name: 'over-long', make: (b) => { const x = new Uint8Array(b.length + 1); x.set(b); return { bytes: x, stateCount: STATE_COUNT }; } },
];

interface FixtureCase {
  readonly name: string;
  readonly sy: number[];
  readonly idx: number[];
  readonly value: number[];
  readonly genKey: [number, number];
  readonly ticks: FluidTick[];
  readonly hex: string;
}

function measureE1(): { values: Record<string, number>; problems: string[] } {
  const t0 = now();
  const next = testRng(E1_SEED);
  const problems = problemList();
  const sys = new Set<number>();
  let roundTripFailures = 0;
  let canonicalFailures = 0;
  let rejectFailures = 0;
  let rebuilds = 0;
  let entries = 0;
  const rejectsTried = new Set<string>();
  for (let c = 0; c < E1_COLUMNS; c++) {
    const col = randomColumn(next, sys);
    const what = `E1 seed 0x${E1_SEED.toString(16)} column ${c}`;
    entries += col.diff.sy.length;
    const b = encodeColumnDiff(col.diff, col.genKey, col.ticks);
    const dec = decodeColumnDiff(b, STATE_COUNT);
    const ticksSame = dec.ticks.length === col.ticks.length && dec.ticks.every((t, i) => t.packedPos === col.ticks[i]!.packedPos && t.dueOffset === col.ticks[i]!.dueOffset);
    if (!sameDiff(dec.diff, col.diff) || dec.genKey[0] !== col.genKey[0] || dec.genKey[1] !== col.genKey[1] || !ticksSame) {
      roundTripFailures++;
      problems.add(`${what}: decode(encode(d)) ≠ d`);
    }
    if (c % 10 === 0) {
      rebuilds++;
      const filled = createDiffStore();
      for (let i = 0; i < col.diff.sy.length; i++) filled.set(0, 0, col.diff.sy[i]!, col.diff.idx[i]!, col.diff.value[i]!);
      const rebuilt = createDiffStore();
      rebuilt.setColumn(0, 0, dec.diff);
      const r = rebuilt.columnDiff(0, 0);
      let same = r !== null && sameDiff(filled.columnDiff(0, 0)!, r);
      for (let i = 0; same && i < col.diff.sy.length; i++) same = rebuilt.get(0, 0, col.diff.sy[i]!, col.diff.idx[i]!) === col.diff.value[i];
      for (let sy = 0; same && sy < 24; sy++) same = rebuilt.get(0, 0, sy, (sy * 151) % 4096) === filled.get(0, 0, sy, (sy * 151) % 4096);
      if (!same) {
        roundTripFailures++;
        problems.add(`${what}: a DiffStore rebuilt from the decoded column reads differently`);
      }
    }
    if (!bytesOf(encodeColumnDiff(dec.diff, dec.genKey, dec.ticks)).equals(bytesOf(b))) {
      canonicalFailures++;
      problems.add(`${what}: encode(decode(b)) ≠ b`);
    }
    if (!bytesOf(encodeColumnDiff(shuffledDiff(next, col.diff), col.genKey, [...col.ticks].reverse())).equals(bytesOf(b))) {
      canonicalFailures++;
      problems.add(`${what}: a shuffled input order changed the bytes`);
    }
    if (b.byteLength !== encodedSize(col.diff, col.ticks.length) || b.buffer.byteLength !== b.byteLength) {
      canonicalFailures++;
      problems.add(`${what}: ${b.byteLength} B ≠ encodedSize ${encodedSize(col.diff, col.ticks.length)}`);
    }
    for (let t = 0; t < REJECTS.length; t++) {
      const r = REJECTS[(c + t) % REJECTS.length]!;
      const bad = r.make(b, col);
      if (bad === null) continue;
      rejectsTried.add(r.name);
      try {
        decodeColumnDiff(bad.bytes, bad.stateCount);
        rejectFailures++;
        problems.add(`${what}: '${r.name}' decoded`);
      } catch (e) {
        if (!(e instanceof DiffDecodeError)) {
          rejectFailures++;
          problems.add(`${what}: '${r.name}' threw ${String(e)}, not a DiffDecodeError`);
        }
      }
      break;
    }
  }
  if (sys.size !== 24) {
    canonicalFailures++;
    problems.add(`E1: ${sys.size} of the 24 sy drawn`);
  }
  if (rejectsTried.size !== REJECTS.length) {
    rejectFailures++;
    problems.add(`E1: ${rejectsTried.size} of the ${REJECTS.length} reject cases tried`);
  }
  const fixture = JSON.parse(readFileSync(new URL('../fixtures/columnDiffV1.json', import.meta.url), 'utf8')) as { cases: FixtureCase[] };
  for (const f of fixture.cases) {
    const b = encodeColumnDiff({ sy: Uint8Array.from(f.sy), idx: Uint16Array.from(f.idx), value: Uint32Array.from(f.value) }, f.genKey, f.ticks);
    if (hexOf(b) !== f.hex) {
      canonicalFailures++;
      problems.add(`E1: the fixture's '${f.name}' does not encode to its hex`);
    }
  }
  e1Seconds = round3((now() - t0) / 1000);
  return { values: { roundTripFailures, canonicalFailures, rejectFailures, columns: E1_COLUMNS, entries, rebuilds, seconds: e1Seconds }, problems: problems.list };
}

// ---------------------------------------------------------------- E2

async function gunzip(b: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([b as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
}
async function gzip(b: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([b as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
}

/** The menu's Import (D15): the file read, and written in one `writeAll` only when accepted. */
async function importInto(kv: MemoryKV, file: Uint8Array | Blob, newId: string): Promise<Awaited<ReturnType<typeof readWiworld>>> {
  const r = await readWiworld(file, STATE_BOUNDS, newId, Date.now());
  if (r.ok) {
    const w = await createSaves(kv).writeAll(r.dump);
    if (w.status !== 'complete') throw new Error(`E2: the import's write: ${w.status}`);
  }
  return r;
}

async function measureE2(): Promise<{ values: Record<string, number>; problems: string[] }> {
  const t0 = now();
  const problems = problemList();
  let roundTripMismatches = 0;
  let regionHashMismatches = 0;
  const kv = createMemoryKV();
  await createWorld(kv, 'e2', {
    profile: 'amplified', player: player('walk', 47.5, 31), time: { t: 0.62, speedIndex: 2 }, active: 5,
    places: [place('pa', 'A lake', 4, 30.5), place('pb', 'The peak', 0, -70)],
  });
  const p = await openPersistWorld({ kv, worldId: 'e2', rd: RD });
  let sourceHash: string;
  let centre: { cx: number; cz: number };
  try {
    await editMix(p, 20, testRng(0xe2), new Map(), problems, 'E2 seed 0xe2');
    // One step undone: the history holds both sides.
    p.history.undo();
    await p.until(() => p.history.redoSize === 1, 'E2: the undo');
    await flush(p, problems, 'E2');
    sourceHash = p.windowHash(3);
    centre = p.centre;
  } finally {
    p.dispose();
  }
  const source = (await createSaves(kv).readAll('e2'))!;
  const file = await writeWiworld(source);
  const target = createMemoryKV();
  const read = await importInto(target, file, 'e2-imported');
  if (!read.ok) return { values: { roundTripMismatches: 1, regionHashMismatches: 1 }, problems: [`E2: the export was refused: ${read.reason}`] };
  const imported = (await createSaves(target).readAll('e2-imported'))!;
  const parts: Array<[string, unknown, unknown]> = [
    ['the world record', { ...imported.world, id: null }, { ...source.world, id: null }],
    ['the state', { ...imported.state, worldId: null, updated: null }, { ...source.state, worldId: null, updated: null }],
    ['the history', { ...imported.history, worldId: null }, { ...source.history, worldId: null }],
    ['the columns', imported.cols.map((c) => [c.key, hexOf(c.bytes)]), source.cols.map((c) => [c.key, hexOf(c.bytes)])],
  ];
  for (const [what, a, b] of parts) {
    if (sameJson(a, b)) continue;
    roundTripMismatches++;
    problems.add(`E2: ${what} differs after export → import`);
  }
  if (source.history === null || source.history.done.length !== 19 || source.history.undone.length !== 1 || source.state.player?.mode !== 'walk') {
    roundTripMismatches++;
    problems.add('E2: the source world is not saved walking with 19 done and 1 undone steps');
  }
  if (wiworldHash(imported) !== wiworldHash(source)) {
    roundTripMismatches++;
    problems.add(`E2: wiworldHash ${wiworldHash(imported)} ≠ ${wiworldHash(source)}`);
  }
  // The region: genRegion's window with the imported entries as its diff, against the source world's live window.
  const params = loadParams(imported.world);
  if (!params.ok) {
    regionHashMismatches++;
    problems.add('E2: the imported params do not load');
  } else {
    const diff = new Map<number, ColumnDiff>(imported.cols.map((c) => [c.key, decodeColumnDiff(c.bytes, imported.world.stateTable.length).diff]));
    const ref = await genRegion({ seed: imported.world.seedText, params: params.value, cx0: centre.cx - 3, cz0: centre.cz - 3, w: 7, h: 7, upTo: 'L', order: 'spiral', threads: 1, diff });
    if (ref.view.litHash() !== sourceHash) {
      regionHashMismatches++;
      problems.add(`E2: the imported region's hash ${ref.view.litHash()} ≠ the source's ${sourceHash}`);
    }
  }

  // An undecodable column: skipped and counted on import, as on open.
  {
    const bad: WorldDump = { ...source, cols: [...source.cols, { key: colKey(9, 9), bytes: Uint8Array.of(9, 9, 9) }].sort((a, b) => a.key - b.key) };
    const r = await importInto(createMemoryKV(), await writeWiworld(bad), 'e2-bad');
    if (!r.ok || r.skippedColumns !== 1 || r.dump.cols.length !== source.cols.length || r.dump.cols.some((c) => c.key === colKey(9, 9))) {
      roundTripMismatches++;
      problems.add(`E2: a file with one undecodable column: ${r.ok ? `${r.skippedColumns} skipped, ${r.dump.cols.length} columns` : r.reason}`);
    }
  }

  // D15's rejects, each writing nothing.
  const raw = await gunzip(new Uint8Array(await file.arrayBuffer()));
  const headerLen = new DataView(raw.buffer, raw.byteOffset).getUint32(8, true);
  const header = JSON.parse(new TextDecoder().decode(raw.subarray(12, 12 + headerLen))) as Record<string, unknown>;
  /** The file with another header (`headerLen` rewritten), its records kept. */
  const reheader = (h: Record<string, unknown>): Uint8Array => {
    const text = new TextEncoder().encode(JSON.stringify(h));
    const out = new Uint8Array(12 + text.length + raw.length - 12 - headerLen);
    out.set(raw.subarray(0, 12));
    new DataView(out.buffer).setUint32(8, text.length, true);
    out.set(text, 12);
    out.set(raw.subarray(12 + headerLen), 12 + text.length);
    return out;
  };
  const cases: Array<[string, Uint8Array, string]> = [
    ['not gzip', raw, 'Not a .wiworld file'],
    ['a bad magic', await gzip(mutated(raw, (x) => { x[0] = 0x58; })!.bytes), 'Not a .wiworld file'],
    ['another format', await gzip(reheader({ ...header, format: 'wi9-world' })), 'Not a .wiworld file'],
    ['version 2', await gzip(mutated(raw, (x) => { new DataView(x.buffer).setUint32(4, 2, true); })!.bytes), 'Made by a newer version of world-imaginer-voxel'],
    ['a record past the end', await gzip(raw.subarray(0, raw.length - 3)), 'The file is damaged'],
  ];
  const refusing = createMemoryKV();
  for (const [what, bytes, reason] of cases) {
    const before = refusing.opCount;
    const r = await importInto(refusing, bytes, `e2-${what}`);
    if (r.ok || r.reason !== reason || refusing.opCount !== before || refusing.dump('worlds').length !== 0) {
      roundTripMismatches++;
      problems.add(`E2: ${what}: ${r.ok ? 'imported' : `'${r.reason}'`}${refusing.opCount !== before ? ', written' : ''}`);
    }
  }

  // §2.1's normaliser on each state and history field the file carries.
  const step = (y: number, after: number) => ({ edits: [{ x: 1, y, z: 2, before: NO_VALUE, after }] });
  const odd: WorldDump = {
    ...source,
    state: {
      ...source.state,
      player: { ...source.state.player!, mode: 'swim' as 'walk', speed: 500 },
      time: { t: 1.5, speedIndex: 99 },
      places: Array.from({ length: 300 }, (_, i) => place(`n${i}`, i === 1 ? 'x'.repeat(100) : `P${i}`, i === 0 ? 9 : i % 8, i)),
    },
    history: {
      worldId: 'e2',
      done: [step(400, val(STONE)), step(70, val(REGISTRY.stateCount + 3)), ...Array.from({ length: 120 }, (_, i) => step(i - 60, val(STONE)))],
      undone: [],
    },
  };
  const r = await importInto(createMemoryKV(), await writeWiworld(odd), 'e2-odd');
  const checks: Array<[string, boolean]> = r.ok ? [
    ['a speed outside 1-96 takes 12', r.dump.state.player?.speed === DEFAULT_SPEED],
    ['a mode other than walk or fly is fly', r.dump.state.player?.mode === 'fly'],
    ['a t outside [0, 1) takes 08:00', r.dump.state.time.t === DEFAULT_T],
    ['a speedIndex not a time speed\'s index is 0', r.dump.state.time.speedIndex === 0],
    ['a colour outside 0-7 drops its place, and 256 are kept', r.dump.state.places.length === MAX_PLACES && r.dump.state.places[0]!.id === 'n1'],
    ['a long name is cut to 64 characters', [...r.dump.state.places[0]!.name].length === MAX_NAME],
    ['a step outside the world or with an unknown state is dropped, the newest 100 kept', r.dump.history?.done.length === HISTORY_STEPS && r.dump.history.done[0]!.edits[0]!.y === -40],
  ] : [['the file imports', false]];
  for (const [what, ok] of checks) {
    if (ok) continue;
    roundTripMismatches++;
    problems.add(`E2: the normaliser on import: ${what}`);
  }
  return { values: { roundTripMismatches, regionHashMismatches, columns: source.cols.length, fileBytes: file.size, seconds: round3((now() - t0) / 1000) }, problems: problems.list };
}

// ---------------------------------------------------------------- E3

async function measureE3(): Promise<{ values: Record<string, number>; problems: string[] }> {
  const t0 = now();
  const problems = problemList();
  let reloadHashMismatches = 0;
  let reloadStateMismatches = 0;
  const kv = createMemoryKV();
  /** The sim's reply delay while set (the second case's late reply). */
  let forced: number | null = null;
  const delayMs = (): number => forced ?? 0;
  await createWorld(kv, 'e3', {
    player: player('walk', 123.5, 18), time: { t: 0.3, speedIndex: 1 }, active: 3,
    places: [place('p1', 'Home', 2, 12.5), place('p2', 'Mine', 6, -30)],
  });
  const edited = new Map<string, Edited>();
  let p = await openPersistWorld({ kv, worldId: 'e3', rd: RD, delayMs });
  let before: { hash: string; saved: { state: StateRecord; history: HistoryRecord } };
  try {
    const opened = p.state();
    if (opened.player?.mode !== 'walk' || opened.player.yaw !== 123.5 || opened.time.t !== 0.3 || opened.hotbar.active !== 3 || opened.places.length !== 2) {
      reloadStateMismatches++;
      problems.add('E3: the world did not open at its stored pose, mode, time, slot and places');
    }
    await editMix(p, 50, testRng(0xe3), edited, problems, 'E3 seed 0xe3');
    if (edited.size !== 50 || p.history.size !== 50) problems.add(`E3: ${edited.size} edits accepted, ${p.history.size} steps (50 expected)`);
    await flush(p, problems, 'E3');
    before = { hash: p.windowHash(3), saved: p.build() };
  } finally {
    p.dispose();
  }
  const ordered = [...edited.values()];
  // The second case's voxel: the last step's (the 50th edit).
  const stale = ordered.at(-1)!;
  p = await openPersistWorld({ kv, worldId: 'e3', rd: RD, delayMs });
  try {
    const hash = p.windowHash(3);
    if (hash !== before.hash) {
      reloadHashMismatches++;
      problems.add(`E3: the window's hash after the reload ${hash} ≠ ${before.hash}`);
    }
    reloadHashMismatches += staleVoxels(p.store, ordered, problems, 'E3 after the reload');
    reloadStateMismatches += stateDiffs(p.build(), before.saved, problems, 'E3 after the reload');

    // The second case: the last step's voxel edited again, its reply 40 ms late, past a flush posted at once.
    const newer = stale.value === val(GLASS) ? val(STONE) : val(GLASS);
    forced = 40;
    const late = p.edit([{ x: stale.x, y: stale.y, z: stale.z, op: 'set', value: newer, expect: stale.value }]);
    forced = null;
    const hide = p.flushNow();
    const [out, f] = await Promise.all([late, hide]);
    if (!out.ok || !f.ok) problems.add(`E3: the late edit ${out.ok ? 'accepted' : out.why}, the flush ${f.ok ? 'committed' : 'refused'}`);
    else syncMs.push(f.syncMs);
    stale.value = newer;
  } finally {
    p.dispose();
  }
  p = await openPersistWorld({ kv, worldId: 'e3', rd: RD, delayMs });
  try {
    if (p.history.size !== 50) {
      reloadStateMismatches++;
      problems.add(`E3: the reopened history holds ${p.history.size} steps, not the 50 flushed`);
    }
    const shown = p.notices.length;
    for (let i = 0; i < 60 && p.history.size > 0; i++) {
      const size = p.history.size;
      p.history.undo();
      await p.until(() => p.history.size < size, `E3: undo ${i}`);
    }
    const said = p.notices.slice(shown);
    const changed = said.filter((t) => t === 'Can\'t undo there: the blocks changed').length;
    const undone = said.filter((t) => t === 'Undo · blocks').length;
    if (changed !== 1 || undone !== 49 || p.history.redoSize !== 49) {
      reloadStateMismatches++;
      problems.add(`E3: undoing every step: ${changed} "the blocks changed", ${undone} undone, ${p.history.redoSize} to redo (1, 49 and 49 expected)`);
    }
    reloadStateMismatches += staleVoxels(p.store, ordered, problems, 'E3 after the undos', (e) => (e === stale ? e.value : e.before));
  } finally {
    p.dispose();
  }
  return { values: { reloadHashMismatches, reloadStateMismatches, edits: edited.size, seconds: round3((now() - t0) / 1000) }, problems: problems.list };
}

// ---------------------------------------------------------------- E4

/** A handler's one reply to `m`: posted at once, or when its transaction settles. */
const call = (h: SimHandler, m: unknown): Promise<FromSim> => new Promise((resolve) => h.handle(m, (r) => resolve(r.msg)));

async function measureE4(): Promise<{ values: Record<string, number>; problems: string[] }> {
  const t0 = now();
  const problems = problemList();
  let abortedFlushInconsistent = 0;
  let crashedFlushInconsistent = 0;
  let lostAfterRetry = 0;
  const params = resolveProfile('default');
  const sp = findSpawn(createGenContext(seedFromInput('42'), params));
  const C: [number, number] = [sp.x >> 4, sp.z >> 4];
  const region = await genRegion({ seed: '42', params, cx0: C[0] - 5, cz0: C[1] - 5, w: 10, h: 10, upTo: 'L', order: 'spiral', threads: 1, shared: true });
  const store = region.view.store;
  const kv = createMemoryKV();
  const { world } = await createWorld(kv, 'e4');
  const stateCount = world.stateTable.length;
  let id = 1;
  const loadOf = (flushSeq: number) => ({ type: 'load', id: id++, db: 'wi10', worldId: 'e4', flushSeq, genKey: world.genKey, updated: 0, stateTable: world.stateTable, rewrite: null });
  const h = createSimHandler({ openKV: async () => kv });
  expect((await call(h, { type: 'attach', handles: store.handles(), thread: 15 })).type).toBe('attached');
  expect((await call(h, loadOf(0))).type).toBe('loaded');
  const stateAt = (t: number): StateRecord => ({ ...newState('e4', STATE_BOUNDS), time: { t, speedIndex: 0 } });
  const historyOf = (n: number): HistoryRecord => ({
    worldId: 'e4', done: Array.from({ length: n }, (_, i) => ({ edits: [{ x: 16 * C[0] + i, y: 100, z: 16 * C[1], before: NO_VALUE, after: val(STONE) }] })), undone: [],
  });
  const flushMsg = (t: number, history: HistoryRecord | null) => ({ type: 'flush', id: id++, state: stateAt(t), history });
  const edits = async (list: Edit[], what: string): Promise<void> => {
    const r = await call(h, { type: 'edits', id: id++, edits: list });
    if (r.type !== 'edited' || (r as EditedMsg).refused !== null) problems.add(`E4: ${what}: ${r.type === 'edited' ? `refused '${(r as EditedMsg).refused}'` : r.type}`);
  };
  const at = (x: number, y: number, z: number, value: number): Edit => ({ x, y, z, op: 'set', value, expect: valueAt(store, x, y, z) });

  // The 64 columns (the inner 8 × 8), 4 with a dense section in the sky (sy 22).
  const cols = Array.from({ length: 64 }, (_, i): [number, number] => [C[0] - 4 + (i & 7), C[1] - 4 + (i >> 3)]);
  const DENSE: ReadonlyMap<number, number> = new Map([[0, 2560], [21, 3000], [42, 3600], [63, 4096]]);
  for (let i = 0; i < 64; i++) {
    const [cx, cz] = cols[i]!;
    const n = DENSE.get(i);
    if (n !== undefined) {
      await edits(Array.from({ length: n }, (_, k) => at(16 * cx + (k & 15), 288 + (k >> 8), 16 * cz + ((k >> 4) & 15), val(GLASS))), `the dense column ${i}`);
    } else {
      const list: Edit[] = [];
      for (let j = 0; j <= i % 3; j++) list.push(at(16 * cx + 1 + 4 * j, 300, 16 * cz + 5, val(STONE)));
      await edits(list, `column ${i}`);
    }
  }
  const committedA = await call(h, flushMsg(0.1, historyOf(1)));
  if (committedA.type !== 'flushed' || !(committedA as FlushedMsg).ok) problems.add('E4: the first flush did not commit');
  const snapA = kvSnapshot(kv);
  const colsA = storedCols(kv, 'e4');

  /** A fresh handler's `load` on the same KV: its DiffStore against `stored` (the committed columns), over `keys`. */
  const reopenMismatches = async (stored: ReadonlyMap<number, Uint8Array>, keys: Iterable<number>, flushSeq: number, what: string): Promise<number> => {
    const fresh = createSimHandler({ openKV: async () => kv });
    const loaded = await call(fresh, loadOf(flushSeq));
    if (loaded.type !== 'loaded') {
      problems.add(`E4: ${what}: the reopen answered ${loaded.type}`);
      return 1;
    }
    let n = 0;
    for (const k of new Set([...keys, ...stored.keys()])) {
      const d = (await call(fresh, { type: 'diff', id: id++, cx: colKeyCx(k), cz: colKeyCz(k) })) as DiffMsg;
      const bytes = stored.get(k);
      const want: ColumnDiff = bytes === undefined ? { sy: new Uint8Array(0), idx: new Uint16Array(0), value: new Uint32Array(0) } : decodeColumnDiff(bytes, stateCount).diff;
      if (sameDiff(d, want)) continue;
      n++;
      problems.add(`E4: ${what}: the reopened column (${colKeyCx(k)}, ${colKeyCz(k)}) differs from the committed one`);
    }
    return n;
  };
  const allKeys = cols.map(([cx, cz]) => colKey(cx, cz));
  /** The live DiffStore's column `k` (the handler's own `diff`). */
  const live = async (k: number): Promise<ColumnDiff> => (await call(h, { type: 'diff', id: id++, cx: colKeyCx(k), cz: colKeyCz(k) })) as DiffMsg;
  /** The stored columns of `keys` against the live DiffStore (absent when it holds none). */
  const storedAsLive = async (keys: Iterable<number>, what: string): Promise<number> => {
    const stored = storedCols(kv, 'e4');
    let n = 0;
    for (const k of keys) {
      const d = await live(k);
      const b = stored.get(k);
      if (d.sy.length === 0 ? b === undefined : b !== undefined && sameDiff(decodeColumnDiff(b, stateCount).diff, d)) continue;
      n++;
      problems.add(`E4: ${what}: the stored column (${colKeyCx(k)}, ${colKeyCz(k)}) is not the DiffStore's`);
    }
    return n;
  };

  // All 64 columns edited again (the dense ones in their dense section), a record and a history: then an abort at every op.
  for (let i = 0; i < 64; i++) {
    const [cx, cz] = cols[i]!;
    await edits([DENSE.has(i) ? at(16 * cx, 288, 16 * cz, val(STONE)) : at(16 * cx + 2, 301, 16 * cz + 9, val(GLASS))], `column ${i} again`);
  }
  const record: WorldRecord = { ...world, name: 'E4 renamed' };
  h.handle({ type: 'record', world: record }, (r) => problems.add(`E4: the record answered ${r.msg.type}`));
  const historyB = historyOf(3);
  const OPS = 64 + 3;
  const faults: Array<number | 'commit'> = [...Array.from({ length: OPS }, (_, k) => k), 'commit'];
  for (const k of faults) {
    kv.failAt(k);
    const r = await call(h, flushMsg(0.2, k === 0 ? historyB : null));
    if (r.type !== 'flushed' || (r as FlushedMsg).ok) {
      abortedFlushInconsistent++;
      problems.add(`E4: failAt(${k}): the flush answered ${r.type === 'flushed' ? 'ok' : r.type}`);
    }
    if (kvSnapshot(kv) !== snapA) {
      abortedFlushInconsistent++;
      problems.add(`E4: failAt(${k}): the KV is not the committed snapshot`);
    }
    abortedFlushInconsistent += await reopenMismatches(colsA, allKeys, 1, `failAt(${k})`);
    if (storedState(kv, 'e4')?.flushSeq !== 1) {
      abortedFlushInconsistent++;
      problems.add(`E4: failAt(${k}): the stored flushSeq moved`);
    }
  }
  // The retry commits the union, the aborted batch's history and record, with flushSeq + 1.
  const retry = await call(h, flushMsg(0.3, null)) as FlushedMsg;
  if (!retry.ok || retry.flushSeq !== 2 || retry.columns !== 64) {
    lostAfterRetry++;
    problems.add(`E4: the retry: ${retry.ok ? `flushSeq ${retry.flushSeq}, ${retry.columns} columns` : 'not committed'} (2 and 64 expected)`);
  }
  lostAfterRetry += await storedAsLive(allKeys, 'the retry');
  if (storedState(kv, 'e4')?.flushSeq !== 2 || !sameJson(kv.dump('history').find(([k]) => k === 'e4')?.[1], historyB) || !sameJson(storedWorld(kv, 'e4'), record)) {
    lostAfterRetry++;
    problems.add('E4: the retry did not write the aborted batch\'s flushSeq + 1, history or record');
  }

  // An edit handled between a flush's encode and its completion: in the next flush, after a commit and after an abort.
  for (const fault of [false, true]) {
    const k = allKeys[fault ? 9 : 5]!;
    if (fault) kv.failAt(0);
    const pending = call(h, flushMsg(0.4, null));
    await edits([at(16 * colKeyCx(k) + 7, 302, 16 * colKeyCz(k) + 7, val(TORCH))], `the edit during a ${fault ? 'failing' : 'committing'} flush`);
    const first = (await pending) as FlushedMsg;
    if (first.ok === fault) problems.add(`E4: the flush around the edit ${first.ok ? 'committed' : 'aborted'}`);
    const next = (await call(h, flushMsg(0.5, null))) as FlushedMsg;
    if (!next.ok) problems.add('E4: the flush after the edit did not commit');
    lostAfterRetry += await storedAsLive([k], `the edit during a ${fault ? 'failing' : 'committing'} flush`);
  }

  // A column whose entries are all reverted to the generated value loses its key.
  {
    const k = allKeys[10]!;
    const d = await live(k);
    const list: Edit[] = [];
    for (let i = 0; i < d.sy.length; i++) {
      const x = 16 * colKeyCx(k) + (d.idx[i]! & 15);
      const y = 16 * d.sy[i]! - 64 + (d.idx[i]! >> 8);
      const z = 16 * colKeyCz(k) + ((d.idx[i]! >> 4) & 15);
      list.push({ x, y, z, op: 'revert', value: 0, expect: d.value[i]! });
    }
    await edits(list, 'the reverts');
    const f = (await call(h, flushMsg(0.6, null))) as FlushedMsg;
    if (!f.ok || storedCols(kv, 'e4').has(k) || (await live(k)).sy.length !== 0) {
      lostAfterRetry++;
      problems.add('E4: a column reverted to its generated value kept its key');
    }
  }

  // crashNext: the write never settles; a fresh handler on the same KV reads the last committed snapshot.
  const committed = storedCols(kv, 'e4');
  const seq = storedState(kv, 'e4')!.flushSeq;
  await edits([at(16 * cols[3]![0] + 3, 303, 16 * cols[3]![1] + 3, val(ICE))], 'the edit before the crash');
  kv.crashNext();
  h.handle(flushMsg(0.9, historyOf(5)), () => problems.add('E4: the crashed flush answered'));
  crashedFlushInconsistent += await reopenMismatches(committed, allKeys, seq, 'after crashNext');
  if (storedState(kv, 'e4')?.flushSeq !== seq) {
    crashedFlushInconsistent++;
    problems.add('E4: the stored flushSeq moved after crashNext');
  }
  return { values: { abortedFlushInconsistent, crashedFlushInconsistent, lostAfterRetry, faults: faults.length, seconds: round3((now() - t0) / 1000) }, problems: problems.list };
}

// ---------------------------------------------------------------- E5's flush part

async function measureE5Flush(): Promise<{ values: Record<string, number>; problems: string[] }> {
  const t0 = now();
  const problems = problemList();
  let flushStale = 0;
  let flushLightMismatches = 0;
  const kv = createMemoryKV({ writeDelayMs: E5_WRITE_MS });
  await createWorld(kv, 'e5', { player: player('fly', 10, 12) });
  const next = testRng(0xe5f);
  const edited = new Map<string, Edited>();
  let crashes = 0;
  let inflightCommitted = 0;
  let p = await openPersistWorld({ kv, worldId: 'e5', rd: RD });
  fillFramesEmpty = p.opened.fillFrames;
  /** A batch of 1-3 voxels in one column near the centre, posted; its voxels tracked (`before` at their first edit). */
  const batch = (n: number): { edits: Edit[]; done: Promise<void> } => {
    const value = MIX[n % MIX.length]!(n);
    const list: Edit[] = [];
    const seen = new Set<string>();
    const first = pickVoxel(p, next, n, value, 2);
    for (let k = 0; k < 1 + (next() % 3); k++) {
      const x = (first.x & ~15) + ((first.x + 5 * k) & 15);
      const z = first.z;
      const s = surfaceAt(p.store, x, z);
      const y = value === val(AIR) ? s - 1 : s;
      if (seen.has(vkey(x, y, z))) continue;
      seen.add(vkey(x, y, z));
      const was = valueAt(p.store, x, y, z);
      if (was === value) continue;
      list.push({ x, y, z, op: 'set', value, expect: was });
      if (!edited.has(vkey(x, y, z))) edited.set(vkey(x, y, z), { x, y, z, before: was, value: was });
    }
    const done = p.edit(list).then((out) => {
      if (!out.ok) return;
      for (const e of list) edited.get(vkey(e.x, e.y, e.z))!.value = e.value;
    });
    return { edits: list, done };
  };
  const snapshot = (): Map<string, number> => new Map([...edited].map(([k, e]) => [k, e.value]));
  try {
    for (let round = 0, n = 0; round < E5_ROUNDS; round++) {
      const what = `E5.flush seed 0xe5f round ${round}`;
      for (let i = 0; i < 3; i++) await batch(n++).done;
      const seq = await flush(p, problems, what);
      const atCommitted = snapshot();
      for (let i = 0; i < 3; i++) await batch(n++).done;
      const atInflight = snapshot();
      const crash = next() % 2 === 0;
      if (crash) {
        crashes++;
        kv.crashNext();
      }
      // The flush in the window, and a batch posted after it (never in it); the session torn down at a seeded point.
      const inflight = p.flushNow().catch(() => null);
      const after = batch(n++).done.catch(() => {});
      await sleep(next() % (E5_WRITE_MS + 10));
      p.dispose();
      await Promise.all([inflight, after]);
      await sleep(3 * E5_WRITE_MS);
      const stored = storedState(kv, 'e5')?.flushSeq;
      const holds = stored === seq + 1 && !crash ? atInflight : stored === seq ? atCommitted : null;
      if (holds === null) {
        flushStale++;
        problems.add(`${what}: the stored flushSeq ${stored} is neither the completed flush's ${seq} nor the next${crash ? ' (crashed)' : ''}`);
      }
      if (holds === atInflight) inflightCommitted++;
      p = await openPersistWorld({ kv, worldId: 'e5', rd: RD });
      flushStale += staleVoxels(p.store, edited.values(), problems, `${what} after the reopen`, (e) => holds?.get(vkey(e.x, e.y, e.z)) ?? e.before);
      flushLightMismatches += lightMismatches(p.store, colsOf(edited.values()), problems, `${what} after the reopen`);
      // The reopened world is the truth from here.
      for (const e of edited.values()) e.value = valueAt(p.store, e.x, e.y, e.z);
    }
  } finally {
    p.dispose();
  }
  return {
    values: { flushStale, flushLightMismatches, rounds: E5_ROUNDS, crashes, inflightCommitted, voxels: edited.size, seconds: round3((now() - t0) / 1000) },
    problems: problems.list,
  };
}

// ---------------------------------------------------------------- E6

async function measureE6(): Promise<{ values: Record<string, number>; problems: string[] }> {
  const t0 = now();
  const problems = problemList();
  let olderGeneratorWrong = 0;
  let backupMissing = 0;
  let backupSpurious = 0;
  const kv = createMemoryKV();
  await createWorld(kv, 'e6', { player: player('fly', 0, 12) });
  const edited = new Map<string, Edited>();
  const copiesOf = (): WorldRecord[] => kv.dump('worlds').map(([, v]) => v as WorldRecord).filter((w) => w.backupOf === 'e6');
  const AMP = 4.0;
  let generated: { x: number; y: number; z: number; value: number };
  let backupMs = 0;
  let p = await openPersistWorld({ kv, worldId: 'e6', rd: RD });
  try {
    p.modify(true);
    // 1. A terrain change with no edits: no copy, the latch left clear.
    const r1 = await p.change({ density: { detailAmpHi: 2.0 } });
    if (r1.from !== 'T' || r1.backedUp || p.backups.length !== 0) {
      backupSpurious++;
      problems.add(`E6: a terrain change with no edits: from ${r1.from}, ${p.backups.length} copies`);
    }
    // 2. Edits, one of them the next terrain's own value where today's is air; flushed.
    await editMix(p, 8, testRng(0xe6), edited, problems, 'E6 seed 0xe6');
    const nextParams = applyPatch(SCHEMA, resolveProfile('default'), { density: { detailAmpHi: AMP } });
    if (!nextParams.ok) throw new Error('E6: the next params');
    const ref = await genRegion({ seed: '42', params: nextParams.value, cx0: p.centre.cx, cz0: p.centre.cz, w: 1, h: 1, upTo: 'D', order: 'spiral', threads: 1 });
    let special: Edited | null = null;
    for (let i = 0; i < 256 && special === null; i++) {
      const x = 16 * p.centre.cx + ((7 * i + 3) & 15);
      const z = 16 * p.centre.cz + (((7 * i + 3) >> 4) & 15);
      if (edited.has(vkey(x, surfaceAt(p.store, x, z), z))) continue;
      for (let y = surfaceAt(p.store, x, z); y < 319 && special === null; y++) {
        const want = val(ref.view.block(x, y, z), ref.view.fluid(x, y, z));
        if (want === val(AIR) || ref.view.fluid(x, y, z) !== NO_FLUID || valueAt(p.store, x, y, z) !== val(AIR)) continue;
        const out = await p.edit([{ x, y, z, op: 'set', value: want, expect: val(AIR) }]);
        if (out.ok) special = { x, y, z, before: val(AIR), value: want };
      }
    }
    if (special === null) problems.add('E6: no voxel where the next terrain is solid and today\'s is air');
    else edited.set(vkey(special.x, special.y, special.z), special);
    await flush(p, problems, 'E6');
    const pre = { kept: p.kept(), saved: p.build(), cols: storedCols(kv, 'e6'), updated: storedState(kv, 'e6')!.updated };

    // 3. The next terrain change makes exactly one copy of the world as it was just before it.
    const tb = now();
    const r2 = await p.change({ density: { detailAmpHi: AMP } });
    backupMs = now() - tb;
    const copies = copiesOf();
    if (r2.from !== 'T' || !r2.backedUp || p.backups.length !== 1 || copies.length !== 1) {
      backupMissing++;
      problems.add(`E6: the first change with edits: from ${r2.from}, backed up ${r2.backedUp}, ${copies.length} copies`);
    }
    const copy = copies.length === 1 ? await createSaves(kv).readAll(copies[0]!.id) : null;
    if (copy !== null) {
      const origSeq = storedState(kv, 'e6')!.flushSeq;
      const checks: Array<[string, boolean]> = [
        ['its record, parameters and genKey', sameJson({ ...copy.world, id: 0, name: 0, backupOf: 0 }, { ...pre.kept, id: 0, name: 0, backupOf: 0 })],
        ['its name and backupOf', copy.world.name === `${pre.kept.name} (before the change)` && copy.world.backupOf === 'e6'],
        ['its state', sameJson({ ...copy.state, worldId: 0, updated: 0, flushSeq: 0 }, { ...pre.saved.state, worldId: 0, updated: 0, flushSeq: 0 })],
        ['its flushSeq and updated', copy.state.flushSeq === origSeq && copy.state.updated === pre.updated],
        ['its history', sameJson({ ...copy.history, worldId: 0 }, { ...pre.saved.history, worldId: 0 })],
        ['its diff keys and bytes', sameJson(copy.cols.map((c) => [c.key, hexOf(c.bytes)]), [...pre.cols].map(([k, b]) => [k, hexOf(b)]))],
      ];
      for (const [what, ok] of checks) {
        if (ok) continue;
        backupMissing++;
        problems.add(`E6: the copy's ${what} ≠ the original's just before the change`);
      }
    }
    // The original continues under its id with the new parameters, every block at its coordinates.
    await flush(p, problems, 'E6 after the change');
    const stored = storedWorld(kv, 'e6')!;
    const sp = loadParams(stored);
    if (!sp.ok || sp.value.density.detailAmpHi !== AMP || stored.genKey !== p.kept().genKey || stored.genKey === pre.kept.genKey) {
      backupMissing++;
      problems.add('E6: the original\'s stored record does not hold the new parameters and genKey');
    }
    backupMissing += staleVoxels(p.store, edited.values(), problems, 'E6 after the change');
    if (special !== null) {
      const b = storedCols(kv, 'e6').get(colKey(special.x >> 4, special.z >> 4));
      const d = b === undefined ? null : decodeColumnDiff(b, stored.stateTable.length).diff;
      const idx = (((special.y + 64) & 15) << 8) | ((special.z & 15) << 4) | (special.x & 15);
      const k = d === null ? -1 : [...d.sy].findIndex((sy, i) => sy === (special!.y + 64) >> 4 && d.idx[i] === idx);
      if (d === null || k < 0 || d.value[k] !== special.value) {
        backupMissing++;
        problems.add('E6: the entry equal to the new terrain\'s value is not stored');
      }
    }

    // 4. No copy for a second change in the session, with the mode off, or for 'L', 'MESH' and an adopt.
    const r3 = await p.change({ density: { detailAmpHi: 3.0 } });
    if (r3.from !== 'T' || r3.backedUp || p.backups.length !== 1) {
      backupSpurious++;
      problems.add(`E6: a second change in one mode session: from ${r3.from}, ${p.backups.length} copies`);
    }
    p.modify(false);
    const r4 = await p.change({ density: { detailAmpHi: 2.5 } });
    if (r4.from !== null || r4.backedUp || p.backups.length !== 1) {
      backupSpurious++;
      problems.add(`E6: a change with the mode off: from ${r4.from}, ${p.backups.length} copies`);
    }
    // A new mode session: the draft returns to the applied one while the copy is written; the copy is kept.
    p.modify(true);
    const r5 = await p.change({ density: { detailAmpHi: 2.5 } }, { revertBeforeCommit: true });
    if (r5.from !== null || !r5.backedUp || p.backups.length !== 2 || copiesOf().length !== 2) {
      backupSpurious++;
      problems.add(`E6: the revert while the copy is written: from ${r5.from}, backed up ${r5.backedUp}, ${copiesOf().length} copies (an adopt and the copy kept expected)`);
    }
    p.modify(false);
    p.modify(true);
    for (const from of ['L', 'MESH', null] as const) {
      if (!p.beforeApply(from)) {
        backupSpurious++;
        problems.add(`E6: beforeApply(${from}) held the change`);
      }
    }
    await p.settle(sleep(50), 'E6: after the beforeApply calls');
    if (p.backups.length !== 2 || copiesOf().length !== 2) {
      backupSpurious++;
      problems.add(`E6: ${copiesOf().length} copies after 'L', 'MESH' and an adopt (2 expected)`);
    }
    // A voxel with no entry, read now: today's generated value, the older generator's entry below.
    const gx = 16 * (p.centre.cx + 3) + 4;
    const gz = 16 * p.centre.cz + 4;
    const gy = surfaceAt(p.store, gx, gz) - 5;
    if (p.simClient.hasEntries(gx >> 4, gz >> 4)) problems.add('E6: the generated voxel\'s column holds entries');
    generated = { x: gx, y: gy, z: gz, value: valueAt(p.store, gx, gy, gz) };
    await flush(p, problems, 'E6 before the older generator');
  } finally {
    p.dispose();
  }

  // 5. An older generator: the stored genKey changed, a column with an entry equal to today's generated value added.
  const today = storedWorld(kv, 'e6')!;
  const OLD = today.genKey === 'f00df00df00df00d' ? '0123456789abcdef' : 'f00df00df00df00d';
  const gIdx = (((generated.y + 64) & 15) << 8) | ((generated.z & 15) << 4) | (generated.x & 15);
  const gKey = colKey(generated.x >> 4, generated.z >> 4);
  const ops: WriteOp[] = [
    { op: 'put', store: 'worlds', key: 'e6', value: { ...today, genKey: OLD, generatorVersion: 4 } },
    { op: 'put', store: 'diffs', key: ['e6', gKey], value: encodeColumnDiff({ sy: Uint8Array.of((generated.y + 64) >> 4), idx: Uint16Array.of(gIdx), value: Uint32Array.of(generated.value) }, parseHex64(OLD)) },
  ];
  expect((await kv.write(ops)).status).toBe('complete');
  const worldsBefore = kv.dump('worlds').length;
  p = await openPersistWorld({ kv, worldId: 'e6', rd: RD });
  try {
    const shown = p.notices.filter((t) => t === OLDER_GENERATOR_NOTICE).length;
    const checks: Array<[string, boolean]> = [
      ['the open flagged older, the notice once', p.opened.older && shown === 1],
      ['the entry equal to today\'s generated value read and kept', valueAt(p.store, generated.x, generated.y, generated.z) === generated.value && p.simClient.hasEntries(generated.x >> 4, generated.z >> 4)],
    ];
    olderGeneratorWrong += staleVoxels(p.store, edited.values(), problems, 'E6 older generator');
    await flush(p, problems, 'E6 older generator');
    const rec = storedWorld(kv, 'e6')!;
    const rp = loadParams(rec);
    const b = storedCols(kv, 'e6').get(gKey);
    const d = b === undefined ? null : decodeColumnDiff(b, rec.stateTable.length).diff;
    checks.push(
      ['no copy', p.backups.length === 0 && kv.dump('worlds').length === worldsBefore && copiesOf().length === 2],
      ['the flush wrote today\'s genKey, so the flag no longer holds', rec.genKey === p.kept().genKey && rec.genKey !== OLD && rp.ok && !olderGenerator(rec, rp.value)],
      ['the entry\'s key still stored after the flush', d !== null && d.value.length === 1 && d.value[0] === generated.value],
    );
    for (const [what, ok] of checks) {
      if (ok) continue;
      olderGeneratorWrong++;
      problems.add(`E6 older generator: ${what}`);
    }
  } finally {
    p.dispose();
  }
  return { values: { olderGeneratorWrong, backupMissing, backupSpurious, edits: edited.size, backupChangeMs: round3(backupMs), seconds: round3((now() - t0) / 1000) }, problems: problems.list };
}

// ---------------------------------------------------------------- E7

/** World `from`'s save copied to `id` under `table` (`to(v)` maps a today's value to its stored id); `extra` added. */
async function copyUnderTable(
  kv: MemoryKV, from: WorldDump, id: string, table: string[], to: (v: number) => number, extra: { key: number; diff: ColumnDiff } | null,
): Promise<void> {
  const mapDiff = (d: ColumnDiff): ColumnDiff => ({ sy: d.sy, idx: d.idx, value: Uint32Array.from(d.value, to) });
  const cols = from.cols.map((c) => {
    const dec = decodeColumnDiff(c.bytes, from.world.stateTable.length);
    return { key: c.key, bytes: encodeColumnDiff(mapDiff(dec.diff), dec.genKey) };
  });
  if (extra !== null) cols.push({ key: extra.key, bytes: encodeColumnDiff(extra.diff, parseHex64(from.world.genKey)) });
  cols.sort((a, b) => a.key - b.key);
  const mapStep = (s: { edits: HistoryRecord['done'][number]['edits'] }) => ({ edits: s.edits.map((e) => ({ ...e, before: e.before === NO_VALUE ? NO_VALUE : to(e.before), after: e.after === NO_VALUE ? NO_VALUE : to(e.after) })) });
  const w = await createSaves(kv).writeAll({
    world: { ...from.world, id, name: `World ${id}`, stateTable: table },
    state: { ...from.state, worldId: id },
    history: from.history === null ? null : { worldId: id, done: from.history.done.map(mapStep), undone: from.history.undone.map(mapStep) },
    cols,
  });
  if (w.status !== 'complete') throw new Error(`E7: the copy ${id}: ${w.status}`);
}

async function measureE7(): Promise<{ values: Record<string, number>; problems: string[] }> {
  const t0 = now();
  const problems = problemList();
  let crossWorldLeaks = 0;
  let deleteLeftovers = 0;
  let perWorldStateWrong = 0;
  let remapMismatches = 0;
  const kv = createMemoryKV();
  const a = await createWorld(kv, 'e7a', { player: player('walk', 10, 20), time: { t: 0.4, speedIndex: 1 }, active: 2, places: [place('a1', 'A', 1, 5)] });
  const b = await createWorld(kv, 'e7b', { player: player('fly', 200, 40), time: { t: 0.8, speedIndex: 3 }, active: 7, places: [place('b1', 'B', 5, -9), place('b2', 'B2', 3, 100)] });
  if (a.world.genKey !== b.world.genKey) problems.add('E7: the two worlds\' genKeys differ');
  const editsA = new Map<string, Edited>();
  const editsB = new Map<string, Edited>();
  const empty = (id: string): HistoryRecord => ({ worldId: id, done: [], undone: [] });
  let savedA: { state: StateRecord; history: HistoryRecord };
  /** The voxel of the remap's extra entry under the unknown key: underground in a column e7a does not edit, in the window. */
  const ux = 16 * 3 + 6;
  const uz = 16 * -3 + 6;
  let uy = 0;
  let uGenerated = val(AIR);
  let p = await openPersistWorld({ kv, worldId: 'e7a', rd: RD });
  try {
    uy = surfaceAt(p.store, ux, uz) - 8;
    uGenerated = valueAt(p.store, ux, uy, uz);
    if (uGenerated === val(AIR)) problems.add(`E7: the unknown entry's voxel (${ux}, ${uy}, ${uz}) is air already`);
    perWorldStateWrong += stateDiffs(p.build(), { state: a.state, history: empty('e7a') }, problems, 'E7 e7a opened');
    await editMix(p, 10, testRng(0xe7a), editsA, problems, 'E7 seed 0xe7a', { kinds: LOW });
    await flush(p, problems, 'E7 e7a');
    savedA = p.build();
  } finally {
    p.dispose();
  }
  p = await openPersistWorld({ kv, worldId: 'e7b', rd: RD });
  let savedB: { state: StateRecord; history: HistoryRecord };
  try {
    perWorldStateWrong += stateDiffs(p.build(), { state: b.state, history: empty('e7b') }, problems, 'E7 e7b opened');
    crossWorldLeaks += staleVoxels(p.store, editsA.values(), problems, 'E7: e7a\'s edit in e7b', (e) => e.before);
    await editMix(p, 10, testRng(0xe7b), editsB, problems, 'E7 seed 0xe7b', { kinds: LOW, taken: new Set(editsA.keys()) });
    await flush(p, problems, 'E7 e7b');
    savedB = p.build();
  } finally {
    p.dispose();
  }
  p = await openPersistWorld({ kv, worldId: 'e7a', rd: RD });
  try {
    crossWorldLeaks += staleVoxels(p.store, editsB.values(), problems, 'E7: e7b\'s edit in e7a', (e) => e.before);
    crossWorldLeaks += staleVoxels(p.store, editsA.values(), problems, 'E7: e7a\'s own edit after its reopen');
    perWorldStateWrong += stateDiffs(p.build(), savedA, problems, 'E7 e7a reopened');
  } finally {
    p.dispose();
  }
  if (sameJson(stateParts(savedA.state), stateParts(savedB.state))) problems.add('E7: the two worlds saved the same state');
  // The stored ranges: each world's entries are its own edits only.
  for (const [id, own, other] of [['e7a', editsA, editsB], ['e7b', editsB, editsA]] as const) {
    const stored = new Map<string, number>();
    for (const [k, bytes] of storedCols(kv, id)) {
      const d = decodeColumnDiff(bytes, todayStateTable().length).diff;
      for (let i = 0; i < d.sy.length; i++) {
        stored.set(vkey(16 * colKeyCx(k) + (d.idx[i]! & 15), 16 * d.sy[i]! - 64 + (d.idx[i]! >> 8), 16 * colKeyCz(k) + ((d.idx[i]! >> 4) & 15)), d.value[i]!);
      }
    }
    for (const [k, v] of stored) {
      if (own.get(k)?.value === v && !other.has(k)) continue;
      crossWorldLeaks++;
      problems.add(`E7: ${id}'s stored entry at (${k}) is not its own edit`);
    }
    if (stored.size !== own.size) {
      crossWorldLeaks++;
      problems.add(`E7: ${id} stores ${stored.size} entries for its ${own.size} edits`);
    }
  }

  // The remap: copies of e7a under another table.
  const dumpA = (await createSaves(kv).readAll('e7a'))!;
  const today = todayStateTable();
  const N = today.length;
  const last = val(N - 1);
  const remapCase = async (id: string, table: string[], to: (v: number) => number, unknown: boolean): Promise<void> => {
    const what = `E7 ${id} (${unknown ? 'today\'s table reversed plus an unknown key' : `a prefix of ${table.length} keys`})`;
    const extra = unknown ? { key: colKey(ux >> 4, uz >> 4), diff: { sy: Uint8Array.of((uy + 64) >> 4), idx: Uint16Array.of((((uy + 64) & 15) << 8) | ((uz & 15) << 4) | (ux & 15)), value: Uint32Array.of(val(N)) } } : null;
    await copyUnderTable(kv, dumpA, id, table, to, extra);
    const added: Edited[] = [];
    let history: HistoryRecord;
    let q = await openPersistWorld({ kv, worldId: id, rd: RD });
    try {
      remapMismatches += staleVoxels(q.store, editsA.values(), problems, `${what} opened`);
      if (q.opened.loaded.unknownStates !== (unknown ? 1 : 0) || (unknown && valueAt(q.store, ux, uy, uz) !== val(AIR))) {
        remapMismatches++;
        problems.add(`${what}: ${q.opened.loaded.unknownStates} unknown states counted, the unknown entry reads ${valueAt(q.store, ux, uy, uz)}`);
      }
      if (!sameJson([q.build().history.done, q.build().history.undone], [savedA.history.done, savedA.history.undone])) {
        remapMismatches++;
        problems.add(`${what}: the opened history ≠ e7a's`);
      }
      const rec = storedWorld(kv, id)!;
      const reencoded = [...storedCols(kv, id)].every(([k, bytes]) => {
        const own = dumpA.cols.find((c) => c.key === k);
        return own === undefined ? unknown && k === extra!.key : hexOf(own.bytes) === hexOf(bytes);
      });
      if (!sameJson(rec.stateTable, today) || !reencoded) {
        remapMismatches++;
        problems.add(`${what}: after the open the stored table is ${sameJson(rec.stateTable, today) ? '' : 'not '}today's and the columns are ${reencoded ? '' : 'not '}under today's ids`);
      }
      // An edit with a state outside the stored table (the last of today's), then a flush and a reopen.
      const x = 16 * q.centre.cx + 12;
      const z = 16 * q.centre.cz + 3;
      const y = surfaceAt(q.store, x, z);
      const was = valueAt(q.store, x, y, z);
      const out = await q.edit([{ x, y, z, op: 'set', value: last, expect: was }]);
      if (!out.ok) problems.add(`${what}: the edit with state ${N - 1} was refused`);
      else added.push({ x, y, z, before: was, value: last });
      await flush(q, problems, what);
      history = q.build().history;
    } finally {
      q.dispose();
    }
    q = await openPersistWorld({ kv, worldId: id, rd: RD });
    try {
      remapMismatches += staleVoxels(q.store, [...editsA.values(), ...added], problems, `${what} reopened`);
      if (unknown && valueAt(q.store, ux, uy, uz) !== val(AIR)) {
        remapMismatches++;
        problems.add(`${what} reopened: the unknown entry is not air`);
      }
      if (!sameJson([q.build().history.done, q.build().history.undone], [history.done, history.undone]) || history.done.length !== savedA.history.done.length + 1) {
        remapMismatches++;
        problems.add(`${what} reopened: the history ≠ the flushed one`);
      }
      if (!sameJson(storedWorld(kv, id)!.stateTable, today)) {
        remapMismatches++;
        problems.add(`${what} reopened: the stored table is not today's`);
      }
    } finally {
      q.dispose();
    }
  };
  await remapCase('e7p', [...today].reverse().concat(['nope[x=1]']), (v) => val(N - 1 - (v >>> 8), v & 0xFF), true);
  let maxId = 0;
  for (const e of editsA.values()) maxId = Math.max(maxId, e.value >>> 8, e.before >>> 8);
  for (const s of savedA.history.done) for (const e of s.edits) for (const v of [e.before, e.after]) if (v !== NO_VALUE) maxId = Math.max(maxId, v >>> 8);
  if (maxId + 1 >= N) problems.add(`E7: no strict prefix holds e7a's states (the largest id ${maxId})`);
  else await remapCase('e7q', today.slice(0, maxId + 1), (v) => v, false);

  // Delete removes every key of the world, and nothing of the other.
  const before = canonicalJSON(storedWorld(kv, 'e7a'));
  const w = await createSaves(kv).remove('e7b');
  if (w.status !== 'complete') problems.add(`E7: the delete: ${w.status}`);
  for (const s of STORES) {
    for (const [k] of kv.dump(s)) {
      if (k !== 'e7b' && !(Array.isArray(k) && k[0] === 'e7b')) continue;
      deleteLeftovers++;
      problems.add(`E7: ${s} keeps ${JSON.stringify(k)} after the delete`);
    }
  }
  if (canonicalJSON(storedWorld(kv, 'e7a')) !== before || storedCols(kv, 'e7a').size === 0 || storedState(kv, 'e7a') === undefined) {
    deleteLeftovers++;
    problems.add('E7: the delete of e7b changed e7a');
  }
  return { values: { crossWorldLeaks, deleteLeftovers, perWorldStateWrong, remapMismatches, seconds: round3((now() - t0) / 1000) }, problems: problems.list };
}

// ---------------------------------------------------------------- the metrics

metricTest('E1', ['roundTripFailures', 'canonicalFailures', 'rejectFailures'], () => {
  const m = measureE1();
  expect.soft(m.problems, `E1 (tier ${TIER}): first ${PROBLEMS} problems`).toEqual([]);
  return m.values;
});

metricTest('E2', ['roundTripMismatches', 'regionHashMismatches'], async () => {
  const m = await measureE2();
  expect.soft(m.problems, `E2 (tier ${TIER}): first ${PROBLEMS} problems`).toEqual([]);
  return m.values;
});

metricTest('E3', ['reloadHashMismatches', 'reloadStateMismatches'], async () => {
  const m = await measureE3();
  expect.soft(m.problems, `E3 (tier ${TIER}): first ${PROBLEMS} problems`).toEqual([]);
  return m.values;
});

metricTest('E4', ['abortedFlushInconsistent', 'crashedFlushInconsistent', 'lostAfterRetry'], async () => {
  const m = await measureE4();
  expect.soft(m.problems, `E4 (tier ${TIER}): first ${PROBLEMS} problems`).toEqual([]);
  return m.values;
});

metricTest('E5', ['flushStale', 'flushLightMismatches'], async () => {
  const m = await measureE5Flush();
  expect.soft(m.problems, `E5's flush part (tier ${TIER}): first ${PROBLEMS} problems`).toEqual([]);
  return m.values;
}, 600_000, { outName: 'E5.flush' });

metricTest('E6', ['olderGeneratorWrong', 'backupMissing', 'backupSpurious'], async () => {
  const m = await measureE6();
  expect.soft(m.problems, `E6 (tier ${TIER}): first ${PROBLEMS} problems`).toEqual([]);
  return m.values;
});

metricTest('E7', ['crossWorldLeaks', 'deleteLeftovers', 'perWorldStateWrong', 'remapMismatches'], async () => {
  const m = await measureE7();
  expect.soft(m.problems, `E7 (tier ${TIER}): first ${PROBLEMS} problems`).toEqual([]);
  return m.values;
});

/**
 * Recorded, not gated (spec §6.2's last paragraph, D19, D26): the frames to the first fill with an empty and a heavy
 * save, the heavy save's decode, its backup's time and the DiffStore's heap estimate, `flushSyncP95Ms` over the run's
 * committed flushes (the E tests above run first, in file order) and E1's time, in `.out/persist.json`.
 */
test('persist: the recorded values (not gated)', async () => {
  const kv = createMemoryKV();
  if (fillFramesEmpty === null) {
    await createWorld(kv, 'empty', { player: player('fly', 0, 12) });
    const empty = await openPersistWorld({ kv, worldId: 'empty', rd: RD });
    fillFramesEmpty = empty.opened.fillFrames;
    empty.dispose();
  }
  // The heavy save: every column of the RD 4 + 3 disc with 64 sparse entries (sy 23), 16 of them with a dense section (sy 22).
  const { world } = await createWorld(kv, 'heavy', { player: player('fly', 0, 12) });
  const genKey = parseHex64(world.genKey);
  const next = testRng(0x4ea);
  const R = RD + 3;
  const disc: number[] = [];
  for (let cz = -R; cz <= R; cz++) for (let cx = -R; cx <= R; cx++) if (cx * cx + cz * cz <= R * R) disc.push(colKey(cx, cz));
  const dense = new Set<number>();
  while (dense.size < 16) dense.add(disc[next() % disc.length]!);
  const diffs = new Map<number, ColumnDiff>();
  let entries = 0;
  for (const k of disc) {
    const sy: number[] = [];
    const idx: number[] = [];
    const value: number[] = [];
    if (dense.has(k)) for (let i = 0; i < 4096; i++) { sy.push(22); idx.push(i); value.push(val(GLASS)); }
    for (let i = 0; i < 64; i++) { sy.push(23); idx.push(64 * i + (next() % 64)); value.push(val(STONE)); }
    diffs.set(k, { sy: Uint8Array.from(sy), idx: Uint16Array.from(idx), value: Uint32Array.from(value) });
    entries += sy.length;
  }
  expect((await kv.write([...diffs].map(([k, d]): WriteOp => ({ op: 'put', store: 'diffs', key: ['heavy', k], value: encodeColumnDiff(d, genKey) })))).status).toBe('complete');
  const heap0 = process.memoryUsage().heapUsed;
  const store = createDiffStore();
  for (const [k, d] of diffs) store.setColumn(colKeyCx(k), colKeyCz(k), d);
  const diffStoreMB = (process.memoryUsage().heapUsed - heap0) / (1 << 20);
  const heavy = await openPersistWorld({ kv, worldId: 'heavy', rd: RD });
  let backupMs = 0;
  try {
    const t = now();
    const r = await heavy.settle(heavy.simClient.backup({
      newWorld: { ...heavy.kept(), id: 'heavy-copy', name: 'Heavy copy', backupOf: 'heavy' }, newId: 'heavy-copy', ...heavy.build(),
    }), 'the heavy backup');
    backupMs = now() - t;
    expect(r.ok, 'the heavy backup committed').toBe(true);
    expect(heavy.opened.loaded.entries).toBe(entries);
  } finally {
    heavy.dispose();
  }
  const values = {
    flushSyncP95Ms: round3(percentile(syncMs, 0.95)),
    flushes: syncMs.length,
    fillFramesEmpty,
    fillFramesHeavy: heavy.opened.fillFrames,
    heavyColumns: disc.length,
    heavyEntries: entries,
    heavyDecodeMs: round3(heavy.opened.loaded.decodeMs),
    heavyBackupMs: round3(backupMs),
    heavyDiffStoreMB: round3(diffStoreMB),
    e1Seconds,
  };
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'persist.json'), `${JSON.stringify({ id: 'persist', tier: process.env.METRICS_TIER ?? null, values }, null, 2)}\n`);
}, 600_000);
