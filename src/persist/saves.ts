/**
 * Saved worlds' records (SP5b spec §2.1-§2.3; master §2.7), the pure part: the records of the `worlds`, `state`,
 * `history` and `historySteps` stores (the history one record per step from `wi10` v2, SP5c spec §5, D28's lever 3:
 * the page's step ids, `createStepIds`; the sim's ops, `historyOps`), the `worlds` record's shape check, the saved
 * params load (D33: `migrate` → `applyPatch` over
 * `resolveProfile(profile)`, so a leaf a later SP adds takes the world's profile value), the `stateTable` remap (D22:
 * stored id → today's id, a key that no longer parses → air), the older-generator check (D8), and the one normaliser
 * every `state` and `history` record goes through, at open, at import and under the tick's snapshot; and the records
 * over the KV (§1.2, §1.3, §2.4, E7): the worlds menu's list, create, rename, delete and export and import batches, the
 * sim's flush and copy batches, and the names the menu proposes (D2, D11, D15); `openSaves` is null when storage
 * cannot open (§3.8, D14).
 *
 * `persist/` value-imports the L2 core only, so the bounds that live in `player/`, `daynight/` and `ui/` (the hotbar's
 * `normalizeHotbar`, `TIME_SPEEDS`, the flying speed's range, the camera's y range) come in as `StateBounds`, which the
 * UI builds from them; a history edit is checked with core's window and y range and `REGISTRY.stateCount`, the bounds
 * the sim's `editOk` reads.
 */
import { WINDOW_HALF, yInWorld } from '../core/coords';
import { hex64 } from '../core/hash';
import { applyPatch, isObj, type Result } from '../core/params/kit';
import { migrate, type JsonObject } from '../core/params/migrate';
import { isProfileId, isProfileReady, resolveProfile, type ProfileId } from '../core/params/profiles';
import { SCHEMA, type Params } from '../core/params/schema';
import { genKey, stageHashes } from '../core/stage/hash';
import { NO_ENTRY } from '../sim/diffStore';
import { MAX_STEP_EDITS } from '../sim/edits';
import { REGISTRY } from '../world/blocks';
import type { ColumnDiff } from '../world/store/api';
import { worldRange, type KV, type WriteOp, type WriteResult } from './kv';

/** The `worlds` record (§2.1): `params` the full document (master §2.7), `backupOf` the original's id (D11). */
export interface WorldRecord {
  id: string;
  name: string;
  seedText: string;
  seed: [number, number];
  profile: ProfileId;
  params: JsonObject;
  schemaVersion: number;
  /** 16 hex digits (`hex64`). */
  paramsHash: string;
  generatorVersion: number;
  /** 16 hex digits (`hex64`). */
  genKey: string;
  /** `stateKey(s)` for every id the world's records hold (D22). */
  stateTable: string[];
  created: number;
  backupOf: string | null;
}

/** The saved pose: `y` is the eye (`player/fly.ts`). */
export interface PlayerRecord {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  mode: 'walk' | 'fly';
  speed: number;
}

/** A saved place (D12): `colour` 0-7, an index of the place colours. */
export interface Place {
  id: string;
  name: string;
  colour: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
}

/** The hotbar as `player/hotbar.ts` stores it, by type name (no remap). */
export interface HotbarRecord {
  v: 1;
  active: number;
  slots: readonly unknown[];
}

/** The `state` record (§2.1). */
export interface StateRecord {
  worldId: string;
  flushSeq: number;
  updated: number;
  player: PlayerRecord | null;
  time: { t: number; speedIndex: number };
  hotbar: HotbarRecord;
  places: Place[];
}

/** One edit of a history step, as `BlockStep`'s: values `state << 8 | fluid`, or `NO_VALUE` for no entry. */
export interface HistoryEdit {
  x: number;
  y: number;
  z: number;
  before: number;
  after: number;
}

/** One step of a history side: its edits, in the order they were applied. */
export interface HistoryStep {
  edits: HistoryEdit[];
}

/**
 * A world's whole history (§2.1), each side at most `HISTORY_STEPS` steps, the newest last: what the normaliser gives,
 * the block history restores and `.wiworld`'s header holds. `wi10` v1 stored it as one `history` record; from v2 (SP5c
 * spec §5, D28's lever 3) the store holds a `HistoryIndex` and each step its own `historySteps` record, and `readAll`
 * assembles this record for Export.
 */
export interface HistoryRecord {
  worldId: string;
  done: HistoryStep[];
  undone: HistoryStep[];
}

/**
 * The `history` record from `wi10` v2 (SP5c spec §5, D28's lever 3): each side's step ids, oldest first; step `id` is
 * the `historySteps` record under `[worldId, id]`, `{edits}`.
 */
export interface HistoryIndex {
  worldId: string;
  done: number[];
  undone: number[];
}

/** A step as a flush or a backup posts it: its id in `historySteps` and its edits. */
export interface IdStep {
  readonly id: number;
  readonly edits: readonly HistoryEdit[];
}

/**
 * A history as the page posts it to the sim (a `flush`, a `backup`, a `load`'s rewrite): the index, and the steps it
 * names whose records are not stored yet (a flush), or every step it names (a backup, a rewrite: `wholeWrite`). The sim
 * writes it with `historyOps`.
 */
export interface HistoryWrite {
  readonly worldId: string;
  readonly done: readonly number[];
  readonly undone: readonly number[];
  readonly steps: readonly IdStep[];
}

/**
 * A history's step ids as the open read them (`normalizeHistory`): each kept step's id (by the step object), the ids
 * whose `historySteps` record is stored, and the first id no stored record or kept step uses.
 */
export interface HistoryIds {
  readonly of: ReadonlyMap<object, number>;
  readonly stored: ReadonlySet<number>;
  readonly next: number;
}

/**
 * The bounds the normaliser checks that live outside `persist/`'s layer, injected: the UI's `STATE_BOUNDS` builds them
 * from `normalizeHotbar`, `TIME_SPEEDS.length`, `SPEED_MIN`/`SPEED_MAX`, `WINDOW_HALF` (flight has no horizontal
 * limit, so a pose is bounded by the world window, not by `?at`'s `AT_LIMIT`) and the camera's `Y_MIN`/`Y_MAX`.
 */
export interface StateBounds {
  normalizeHotbar(raw: unknown): HotbarRecord;
  timeSpeedCount: number;
  speedMin: number;
  speedMax: number;
  xzLimit: number;
  yMin: number;
  yMax: number;
}

/** Places kept per world. */
export const MAX_PLACES = 256;
/** A place name's characters. */
export const MAX_NAME = 64;
/** Steps per history side: `BLOCK_HISTORY_STEPS` (pinned equal in `stateBounds.test.ts`). */
export const HISTORY_STEPS = 100;
/** Edits both history sides hold in all (SP5c spec §5, D14): `MAX_HISTORY_EDITS` (pinned equal in `stateBounds.test.ts`). */
export const MAX_HISTORY_EDITS = 65_536;
/** The flying speed a bad `speed` takes: `SPEED_DEFAULT` (pinned equal in `stateBounds.test.ts`). */
export const DEFAULT_SPEED = 12;
/** The time a bad `t` takes, 08:00: `OPENING_T` (pinned equal in `stateBounds.test.ts`). */
export const DEFAULT_T = 1 / 12;
/** A history value for "no entry": the DiffStore's `NO_ENTRY`. */
export const NO_VALUE = NO_ENTRY;
/** Step ids are below 2^32, so a world's `historySteps` keys lie in `worldRange` (as its colKeys do). */
export const STEP_ID_LIMIT = 2 ** 32;

const HEX64 = /^[0-9a-f]{16}$/;
const PLACE_COLOURS = 8;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isU32 = (v: unknown): v is number => isInt(v) && v >= 0 && v <= 0xFFFFFFFF;
/** −0 → 0 (`canonicalJSON` throws on −0). */
const noNegZero = (v: number): number => (v === 0 ? 0 : v);

// ---------------------------------------------------------------- the worlds record

/** The first failing field's check, in the record's field order. */
const WORLD_FIELDS: readonly [field: keyof WorldRecord, ok: (v: unknown) => boolean, expected: string][] = [
  ['id', (v) => typeof v === 'string', 'a string'],
  ['name', (v) => typeof v === 'string', 'a string'],
  ['seedText', (v) => typeof v === 'string', 'a string'],
  ['seed', (v) => Array.isArray(v) && v.length === 2 && isU32(v[0]) && isU32(v[1]), 'two u32 words'],
  ['profile', isProfileId, 'a known profile'],
  ['params', isObj, 'an object'],
  ['schemaVersion', isInt, 'an integer'],
  ['paramsHash', (v) => typeof v === 'string' && HEX64.test(v), '16 hex digits'],
  ['generatorVersion', isInt, 'an integer'],
  ['genKey', (v) => typeof v === 'string' && HEX64.test(v), '16 hex digits'],
  ['stateTable', (v) => Array.isArray(v) && v.every((k) => typeof k === 'string'), 'a list of state keys'],
  ['created', isNum, 'a finite number'],
  ['backupOf', (v) => v === null || typeof v === 'string', 'a string or null'],
];

/** The `worlds` record's one shape check (`list`'s broken rows, `readSavedWorld`); `reason` names the first bad field. */
export function parseWorldRecord(raw: unknown): { ok: true; world: WorldRecord } | { ok: false; reason: string } {
  if (!isObj(raw)) return { ok: false, reason: 'the world record is not a record' };
  for (const [field, ok, expected] of WORLD_FIELDS) {
    if (!ok(raw[field])) return { ok: false, reason: `the world record's ${field} is not ${expected}` };
  }
  const r = raw as unknown as WorldRecord;
  return {
    ok: true,
    world: {
      id: r.id, name: r.name, seedText: r.seedText, seed: [r.seed[0], r.seed[1]], profile: r.profile, params: r.params,
      schemaVersion: r.schemaVersion, paramsHash: r.paramsHash, generatorVersion: r.generatorVersion, genKey: r.genKey,
      stateTable: [...r.stateTable], created: r.created, backupOf: r.backupOf,
    },
  };
}

/**
 * The saved params (D33): `migrate(params, schemaVersion)`, then `applyPatch` over `resolveProfile(profile)`, so a
 * missing leaf takes the profile's value (`checkParams` would refuse it). The session's own validation is the caller's.
 */
export function loadParams(w: Pick<WorldRecord, 'params' | 'schemaVersion' | 'profile'>): Result<Params> {
  const profile: unknown = w.profile;
  if (!isProfileId(profile)) return { ok: false, issues: [{ path: 'profile', code: 'UNKNOWN_PROFILE', message: `unknown profile ${JSON.stringify(profile)}` }] };
  if (!isProfileReady(profile)) return { ok: false, issues: [{ path: 'profile', code: 'UNKNOWN_PROFILE', message: `profile ${profile} is not available yet` }] };
  if (!isObj(w.params)) return { ok: false, issues: [{ path: 'params', code: 'NOT_OBJECT', message: 'params must be an object' }] };
  const m = migrate(w.params, w.schemaVersion);
  if (!m.ok) return m;
  return applyPatch(SCHEMA, resolveProfile(profile), m.value);
}

/** Whether the world's stored genKey differs from today's for its seed and params (D8), on `loadParams`' params. */
export function olderGenerator(w: WorldRecord, params: Params): boolean {
  return hex64(genKey(w.seed, stageHashes(params))) !== w.genKey;
}

// ---------------------------------------------------------------- the stateTable remap (D22)

/** Today's table: `stateKey(s)` for every `s < stateCount`. */
export function todayStateTable(): string[] {
  const out: string[] = [];
  for (let s = 0; s < REGISTRY.stateCount; s++) out.push(REGISTRY.stateKey(s));
  return out;
}

/** `'equal'` to today's table, a strict `'prefix'` of it (ids are append-only: every id maps to itself), or `'other'`. */
export function tableRelation(stored: readonly string[]): 'equal' | 'prefix' | 'other' {
  if (stored.length > REGISTRY.stateCount) return 'other';
  for (let s = 0; s < stored.length; s++) if (stored[s] !== REGISTRY.stateKey(s)) return 'other';
  return stored.length === REGISTRY.stateCount ? 'equal' : 'prefix';
}

/** `to[id]` is the stored id's state today, −1 for a key `parseStateKey` refuses (`unknownKeys` counts them). */
export function remapOf(stored: readonly string[]): { to: Int32Array; unknownKeys: number } {
  const to = new Int32Array(stored.length);
  let unknownKeys = 0;
  for (let i = 0; i < stored.length; i++) {
    try {
      to[i] = REGISTRY.parseStateKey(stored[i]!);
    } catch {
      to[i] = -1;
      unknownKeys++;
    }
  }
  return { to, unknownKeys };
}

/** The value under today's ids, or −1 when its state is unknown (or past the stored table). `NO_VALUE` is kept. */
function remapped(v: number, to: Int32Array): number {
  if (v === NO_VALUE) return v;
  const id = v >>> 8;
  const s = id < to.length ? to[id]! : -1;
  return s < 0 ? -1 : ((s << 8) | (v & 0xFF)) >>> 0;
}

/** One value through the remap: the fluid byte kept, an unknown state → 0 (air, fluid 0), `NO_VALUE` kept. */
export function remapValue(v: number, to: Int32Array): { value: number; unknown: boolean } {
  const r = remapped(v, to);
  return r < 0 ? { value: 0, unknown: true } : { value: r, unknown: false };
}

/**
 * A column's entries through the remap, in fresh arrays; `unknown` counts the entries that became air. Its order stays
 * canonical: one entry per voxel, so no two entries can meet.
 */
export function remapDiff(d: ColumnDiff, to: Int32Array): { diff: ColumnDiff; unknown: number } {
  const value = new Uint32Array(d.value.length);
  let unknown = 0;
  for (let i = 0; i < value.length; i++) {
    const r = remapped(d.value[i]!, to);
    if (r < 0) unknown++;
    value[i] = r < 0 ? 0 : r;
  }
  return { diff: { sy: d.sy.slice(), idx: d.idx.slice(), value }, unknown };
}

// ---------------------------------------------------------------- the normaliser (§2.1)

/** A new world's state: no player (the spawn), 08:00 at ×1, the default hotbar, no places. */
export function newState(worldId: string, b: StateBounds): StateRecord {
  return { worldId, flushSeq: 0, updated: 0, player: null, time: { t: DEFAULT_T, speedIndex: 0 }, hotbar: b.normalizeHotbar(null), places: [] };
}

/** The record's x, y, z inside the saved pose's bounds (x, z in the world window, y in the camera's range), or null. */
function positionOf(raw: Record<string, unknown>, b: StateBounds): { x: number; y: number; z: number } | null {
  const { x, y, z } = raw;
  if (!isNum(x) || !isNum(y) || !isNum(z)) return null;
  if (x < -b.xzLimit || x >= b.xzLimit || z < -b.xzLimit || z >= b.xzLimit || y < b.yMin || y > b.yMax) return null;
  return { x: noNegZero(x), y: noNegZero(y), z: noNegZero(z) };
}

/** The pose, or null (the spawn) when a position, yaw or pitch is bad; a bad `speed` or `mode` takes its default. */
function normalizePlayer(raw: unknown, b: StateBounds): PlayerRecord | null {
  if (!isObj(raw)) return null;
  const { yaw, pitch, mode, speed } = raw;
  const at = positionOf(raw, b);
  if (at === null || !isNum(yaw) || !isNum(pitch)) return null;
  return {
    ...at, yaw: noNegZero(yaw), pitch: noNegZero(pitch),
    mode: mode === 'walk' || mode === 'fly' ? mode : 'fly',
    speed: isNum(speed) && speed >= b.speedMin && speed <= b.speedMax ? speed : DEFAULT_SPEED,
  };
}

/** A place, or null when any field is bad; a long name is cut to `MAX_NAME` characters. */
function normalizePlace(raw: unknown, b: StateBounds): Place | null {
  if (!isObj(raw)) return null;
  const { id, name, colour, yaw, pitch } = raw;
  if (typeof id !== 'string' || typeof name !== 'string' || !isInt(colour) || colour < 0 || colour >= PLACE_COLOURS) return null;
  const at = positionOf(raw, b);
  if (at === null || !isNum(yaw) || !isNum(pitch)) return null;
  return { id, name: Array.from(name).slice(0, MAX_NAME).join(''), colour: noNegZero(colour), ...at, yaw: noNegZero(yaw), pitch: noNegZero(pitch) };
}

/**
 * A `state` record read for `worldId`: every bad field takes its default (a bad pose → no player, `speed` outside the
 * flying range → 12, `t` outside [0, 1) → 08:00, `speedIndex` not a time speed's index → 0, `flushSeq` not a
 * non-negative integer → 0), the hotbar through `b.normalizeHotbar`, bad places dropped and the first `MAX_PLACES`
 * kept, −0 → 0. `reset` when the value is not a record at all (D14's notice).
 */
export function normalizeState(raw: unknown, worldId: string, b: StateBounds): { state: StateRecord; reset: boolean } {
  if (!isObj(raw)) return { state: newState(worldId, b), reset: true };
  const time = isObj(raw['time']) ? raw['time'] : {};
  const { t, speedIndex } = time;
  const places: Place[] = [];
  if (Array.isArray(raw['places'])) {
    for (const p of raw['places'] as unknown[]) {
      if (places.length === MAX_PLACES) break;
      const place = normalizePlace(p, b);
      if (place !== null) places.push(place);
    }
  }
  const { flushSeq, updated } = raw;
  return {
    state: {
      worldId,
      flushSeq: isInt(flushSeq) && flushSeq >= 0 ? noNegZero(flushSeq) : 0,
      updated: isNum(updated) && updated >= 0 ? noNegZero(updated) : 0,
      player: normalizePlayer(raw['player'], b),
      time: {
        t: isNum(t) && t >= 0 && t < 1 ? noNegZero(t) : DEFAULT_T,
        speedIndex: isInt(speedIndex) && speedIndex >= 0 && speedIndex < b.timeSpeedCount ? noNegZero(speedIndex) : 0,
      },
      hotbar: b.normalizeHotbar(raw['hotbar']),
      places,
    },
    reset: false,
  };
}

/**
 * A history value under today's ids, or −1 when the sim's `editOk` would refuse it: `NO_VALUE`, or a u32 whose state,
 * after the remap, is below `REGISTRY.stateCount` and whose fluid byte has its reserved bit 7 clear (the codec refuses
 * it). A state past the stored table is refused, an unknown one is air.
 */
function historyValue(v: unknown, to: Int32Array | null): number {
  if (!isU32(v)) return -1;
  if (v === NO_VALUE) return v;
  if ((v & 0x80) !== 0) return -1;
  if (to !== null && (v >>> 8) >= to.length) return -1;
  const r = to === null ? v + 0 : remapValue(v, to).value;
  return r >>> 8 < REGISTRY.stateCount ? r : -1;
}

/** A step with every edit inside the world (the window, `yInWorld`, integer coordinates) and valid values, or null. */
function normalizeStep(raw: unknown, to: Int32Array | null): HistoryStep | null {
  if (!isObj(raw) || !Array.isArray(raw['edits']) || raw['edits'].length === 0) return null;
  const edits: HistoryEdit[] = [];
  for (const e of raw['edits'] as unknown[]) {
    if (!isObj(e)) return null;
    const { x, y, z } = e;
    if (!isInt(x) || !isInt(y) || !isInt(z) || x < -WINDOW_HALF || x >= WINDOW_HALF || z < -WINDOW_HALF || z >= WINDOW_HALF || !yInWorld(y)) return null;
    const before = historyValue(e['before'], to);
    const after = historyValue(e['after'], to);
    if (before < 0 || after < 0) return null;
    edits.push({ x: noNegZero(x), y: noNegZero(y), z: noNegZero(z), before, after });
  }
  return { edits };
}

/** A stored step id: an integer in 0 … `STEP_ID_LIMIT` − 1. */
const isStepId = (v: unknown): v is number => isInt(v) && v >= 0 && v < STEP_ID_LIMIT;

/** The ids `normalizeHistory` hands out while it reads: the stored ones kept, every other step a fresh one. */
interface IdReader {
  readonly of: Map<object, number>;
  readonly stored: Set<number>;
  next: number;
}

/**
 * One side's raw steps: an id (a v2 index) is looked up in `steps` (an id with no record, or one already used, is
 * invalid), an object (a v1 record, an Import) is the step itself; each valid step gets its id in `ids`.
 */
function sideSteps(raw: unknown[], to: Int32Array | null, steps: ReadonlyMap<number, unknown>, ids: IdReader, used: Set<number>): HistoryStep[] {
  const valid: HistoryStep[] = [];
  for (const s of raw) {
    if (typeof s === 'number') {
      if (!isStepId(s) || used.has(s) || !steps.has(s)) continue;
      used.add(s);
      const step = normalizeStep(steps.get(s), to);
      if (step === null) continue;
      ids.of.set(step, s);
      ids.stored.add(s);
      valid.push(step);
    } else {
      const step = normalizeStep(s, to);
      if (step === null) continue;
      ids.of.set(step, ids.next++);
      valid.push(step);
    }
  }
  return valid;
}

/**
 * One side: the valid steps, the newest `HISTORY_STEPS` kept, then a step over `MAX_STEP_EDITS` dropped (SP5c spec §5);
 * `dropped` counts the rest.
 */
function normalizeSide(raw: unknown, to: Int32Array | null, steps: ReadonlyMap<number, unknown>, ids: IdReader, used: Set<number>): { steps: HistoryStep[]; dropped: number } {
  if (!Array.isArray(raw)) return { steps: [], dropped: 0 };
  const valid = sideSteps(raw as unknown[], to, steps, ids, used);
  const kept = valid.slice(Math.max(0, valid.length - HISTORY_STEPS)).filter((s) => s.edits.length <= MAX_STEP_EDITS);
  return { steps: kept, dropped: raw.length - kept.length };
}

/** The edits of a side's steps. */
function editsIn(side: readonly { edits: readonly HistoryEdit[] }[]): number {
  let n = 0;
  for (const s of side) n += s.edits.length;
  return n;
}

const NO_STEPS: ReadonlyMap<number, unknown> = new Map();

/**
 * A `history` record read for `worldId`, each value remapped through `to` when given (D22): a step with any edit the
 * sim's `editOk` would refuse after the remap is dropped and counted, as are steps past `HISTORY_STEPS` per side (the
 * newest kept) and, as the block history's `restore` does (SP5c spec §5, D14), a step over `MAX_STEP_EDITS`, then,
 * while both sides hold more than `MAX_HISTORY_EDITS` edits, the oldest undo step, then the redo step furthest from the
 * present (`undone[0]`). `undefined` (a new world has no `history` record) is an empty history; any other value that is
 * not a record is an empty one with `reset` (SP5b D14's notice).
 *
 * `wi10` v2 (SP5c spec §5, D28's lever 3): a side's entry is a step id, read from `steps` (the world's `historySteps`
 * records by id; an id with no record is dropped and counted), or, in a v1 record or an Import, the step itself. `ids`
 * gives each kept step's id: a stored step keeps its own, any other gets a fresh one from `next`, past every id `steps`
 * holds, so the page's flushes write only the steps not yet stored.
 */
export function normalizeHistory(
  raw: unknown, worldId: string, to: Int32Array | null, steps: ReadonlyMap<number, unknown> = NO_STEPS,
): { history: HistoryRecord; ids: HistoryIds; reset: boolean; dropped: number } {
  let next = 0;
  for (const id of steps.keys()) if (isStepId(id) && id >= next) next = id + 1;
  const ids: IdReader = { of: new Map(), stored: new Set(), next };
  if (!isObj(raw)) return { history: { worldId, done: [], undone: [] }, ids, reset: raw !== undefined, dropped: 0 };
  const used = new Set<number>();
  const done = normalizeSide(raw['done'], to, steps, ids, used);
  const undone = normalizeSide(raw['undone'], to, steps, ids, used);
  let dropped = done.dropped + undone.dropped;
  let total = editsIn(done.steps) + editsIn(undone.steps);
  while (total > MAX_HISTORY_EDITS) {
    total -= (done.steps.length > 0 ? done.steps.shift()! : undone.steps.shift()!).edits.length;
    dropped++;
  }
  return { history: { worldId, done: done.steps, undone: undone.steps }, ids, reset: false, dropped };
}

// ---------------------------------------------------------------- the history's records (SP5c D28's lever 3)

/** A step as the history's sides hold it (the block history's `BlockStep`, a `HistoryStep`). */
type AnyStep = { readonly edits: readonly HistoryEdit[] };

/**
 * The page's step ids (SP5c spec §5, D28's lever 3): each step keeps one id for as long as it lives (by identity), a new
 * step takes the next free one, and the ids whose records a committed write stored are known, so a flush posts only the
 * steps not stored yet.
 */
export interface StepIds {
  /** Both sides' index and the steps not known to be stored (every step when `whole`: a backup, a rewrite). */
  write(worldId: string, done: readonly AnyStep[], undone: readonly AnyStep[], whole: boolean): HistoryWrite;
  /** `w` was committed: its steps are stored. */
  committed(w: HistoryWrite): void;
}

/** The step ids of a world opened with `seed` (`normalizeHistory`'s `ids`), or of a new one (null). */
export function createStepIds(seed: HistoryIds | null): StepIds {
  const records = new WeakMap<object, IdStep>();
  const stored = new Set<number>(seed?.stored ?? []);
  let next = seed?.next ?? 0;
  if (seed !== null) for (const [step, id] of seed.of) records.set(step, { id, edits: (step as AnyStep).edits });
  const recordOf = (step: AnyStep): IdStep => {
    let r = records.get(step);
    if (r === undefined) records.set(step, (r = { id: next++, edits: step.edits.slice() }));
    return r;
  };
  return {
    write(worldId, done, undone, whole) {
      const steps: IdStep[] = [];
      const side = (from: readonly AnyStep[]): number[] => from.map((s) => {
        const r = recordOf(s);
        if (whole || !stored.has(r.id)) steps.push(r);
        return r.id;
      });
      return { worldId, done: side(done), undone: side(undone), steps };
    },
    committed(w) {
      for (const s of w.steps) stored.add(s.id);
    },
  };
}

/** `h` as a whole write, its steps numbered 0, 1, … (an Import, a test's history). */
export function wholeWrite(h: HistoryRecord): HistoryWrite {
  return createStepIds(null).write(h.worldId, h.done, h.undone, true);
}

/** A whole write as one record (its steps by id, in its index's order; an id it carries no step for left out). */
export function writeRecord(w: HistoryWrite): HistoryRecord {
  const byId = new Map(w.steps.map((s) => [s.id, s]));
  const side = (ids: readonly number[]): HistoryStep[] => ids.flatMap((id) => {
    const s = byId.get(id);
    return s === undefined ? [] : [{ edits: [...s.edits] }];
  });
  return { worldId: w.worldId, done: side(w.done), undone: side(w.undone) };
}

/**
 * The ops that store `w` under `worldId` (SP5c spec §5, D28's lever 3): a `historySteps` put per step it carries, then
 * a `deleteRange` over each run of ids its index does not name (so a dropped step's record goes, and a stray put with
 * it), then the `history` index. Every id the index names is either carried or already stored.
 */
export function historyOps(worldId: string, w: HistoryWrite): WriteOp[] {
  const ops: WriteOp[] = [];
  for (const s of w.steps) ops.push({ op: 'put', store: 'historySteps', key: [worldId, s.id], value: { edits: s.edits } });
  const live = [...w.done, ...w.undone].sort((a, b) => a - b);
  let lower = 0;
  for (const id of live) {
    if (id > lower) ops.push({ op: 'deleteRange', store: 'historySteps', range: { lower: [worldId, lower], upper: [worldId, id] } });
    lower = Math.max(lower, id + 1);
  }
  if (lower < STEP_ID_LIMIT) ops.push({ op: 'deleteRange', store: 'historySteps', range: { lower: [worldId, lower], upper: [worldId, STEP_ID_LIMIT] } });
  const index: HistoryIndex = { worldId, done: [...w.done], undone: [...w.undone] };
  ops.push({ op: 'put', store: 'history', key: worldId, value: index });
  return ops;
}

/**
 * The history as stored, assembled into one record for Export (SP5c spec §5): a v2 index's ids each replaced by its
 * `historySteps` record (an id with none left out), a v1 record's steps as they are; null when `raw` is not a record.
 */
export function assembleHistory(raw: unknown, steps: ReadonlyMap<number, unknown>): HistoryRecord | null {
  if (!isObj(raw)) return null;
  const side = (v: unknown): HistoryStep[] => (Array.isArray(v) ? (v as unknown[]) : []).flatMap((s) => {
    if (typeof s !== 'number') return [s as HistoryStep];
    return steps.has(s) ? [steps.get(s) as HistoryStep] : [];
  });
  return { ...(raw as unknown as HistoryRecord), done: side(raw['done']), undone: side(raw['undone']) };
}

/** A world's `historySteps` records read as `getAll` gives them, by id. */
function stepsOf(all: { keys: readonly (readonly [string, number])[]; values: readonly unknown[] }): Map<number, unknown> {
  return new Map(all.keys.map((k, i) => [k[1], all.values[i]]));
}

// ---------------------------------------------------------------- the records over the KV

/**
 * A Load world row (§1.3): `updated` is the state's `updated` when positive, else the world's `created` (a world never
 * saved since its create); `places` the state's place count. A `worlds` record `parseWorldRecord` refuses stays in the
 * list with its reason, so Delete can remove it (D14).
 */
export type WorldRow =
  | { broken: false; world: WorldRecord; updated: number; places: number }
  | { broken: true; id: string; reason: string };

/** A world's last committed save (Export, Import, the backup copy): `cols` in colKey order, the stored bytes. */
export interface WorldDump {
  world: WorldRecord;
  state: StateRecord;
  history: HistoryRecord | null;
  cols: { key: number; bytes: Uint8Array }[];
}

/** The worlds menu's records over the KV; each method is one `read` or one `write` (rename reads, then writes). */
export interface Saves {
  /** `worlds` and `state` in one read (never `diffs` or `history`), most recently modified first, ties by id; broken rows last. */
  list(): Promise<WorldRow[]>;
  /** The `worlds` and `state` records in one write (§1.2). */
  create(w: WorldRecord, state: StateRecord): Promise<WriteResult>;
  /**
   * The three records as stored (`undefined` when absent) and the world's `historySteps` records by id, in one read; the
   * page parses and normalises them.
   */
  readOpen(id: string): Promise<{ world: unknown; state: unknown; history: unknown; steps: Map<number, unknown> }>;
  /** The name trimmed and cut to `MAX_NAME`; an empty name or a missing or broken record writes nothing. The caller holds the world's lock. */
  rename(id: string, name: string): Promise<WriteResult>;
  /** The three records and the world's `historySteps` and `diffs` ranges in one write (E7). The caller holds the world's lock. */
  remove(id: string): Promise<WriteResult>;
  /**
   * The three records, the `historySteps` range (assembled into the history, `assembleHistory`) and the `diffs` range in
   * one read, so a world open in another tab is read at one `flushSeq`; null without a readable `worlds` record or a
   * `state` record.
   */
  readAll(id: string): Promise<WorldDump | null>;
  /** The three records, every step (numbered 0, 1, …: `wholeWrite`) and every column in one write (Import). */
  writeAll(d: WorldDump): Promise<WriteResult>;
  readonly kv: KV;
}

const nothingWritten = (errorName: string): WriteResult => ({ status: 'abort', errorName });

/** The row's modified time: the state's positive finite `updated`, else the world's `created` (P8). */
function rowOf(world: WorldRecord, state: unknown): WorldRow {
  const updated = isObj(state) && isNum(state['updated']) && state['updated'] > 0 ? state['updated'] : world.created;
  const places = isObj(state) && Array.isArray(state['places']) ? state['places'].length : 0;
  return { broken: false, world, updated, places };
}

const rowId = (r: WorldRow): string => (r.broken ? r.id : r.world.id);

/** Descending by `updated`, ties by id; a broken row has no modified time and sorts after every readable one, by id. */
function compareRows(a: WorldRow, b: WorldRow): number {
  if (a.broken !== b.broken) return a.broken ? 1 : -1;
  if (!a.broken && !b.broken && a.updated !== b.updated) return b.updated - a.updated;
  const ia = rowId(a);
  const ib = rowId(b);
  return ia < ib ? -1 : ia > ib ? 1 : 0;
}

export function createSaves(kv: KV): Saves {
  return {
    kv,
    async list() {
      const [worlds, states] = (await kv.read([
        { op: 'getAll', store: 'worlds', range: null },
        { op: 'getAll', store: 'state', range: null },
      ])) as [{ keys: string[]; values: unknown[] }, { keys: string[]; values: unknown[] }];
      const stateOf = new Map<string, unknown>(states.keys.map((k, i) => [k, states.values[i]]));
      const rows = worlds.keys.map((id, i): WorldRow => {
        const p = parseWorldRecord(worlds.values[i]);
        return p.ok ? rowOf(p.world, stateOf.get(id)) : { broken: true, id, reason: p.reason };
      });
      return rows.sort(compareRows);
    },
    create(w, state) {
      return kv.write([
        { op: 'put', store: 'worlds', key: w.id, value: w },
        { op: 'put', store: 'state', key: w.id, value: state },
      ]);
    },
    async readOpen(id) {
      const [world, state, history, steps] = await kv.read([
        { op: 'get', store: 'worlds', key: id },
        { op: 'get', store: 'state', key: id },
        { op: 'get', store: 'history', key: id },
        { op: 'getAll', store: 'historySteps', range: worldRange(id) },
      ]);
      return { world, state, history, steps: stepsOf(steps as { keys: (readonly [string, number])[]; values: unknown[] }) };
    },
    async rename(id, name) {
      const cut = Array.from(name.trim()).slice(0, MAX_NAME).join('');
      if (cut === '') return nothingWritten('EmptyName');
      const [raw] = await kv.read([{ op: 'get', store: 'worlds', key: id }]);
      const p = parseWorldRecord(raw);
      if (!p.ok) return nothingWritten('NotFound');
      return kv.write([{ op: 'put', store: 'worlds', key: id, value: { ...p.world, name: cut } }]);
    },
    remove(id) {
      return kv.write([
        { op: 'delete', store: 'worlds', key: id },
        { op: 'delete', store: 'state', key: id },
        { op: 'delete', store: 'history', key: id },
        { op: 'deleteRange', store: 'historySteps', range: worldRange(id) },
        { op: 'deleteRange', store: 'diffs', range: worldRange(id) },
      ]);
    },
    async readAll(id) {
      const [world, state, history, steps, diffs] = (await kv.read([
        { op: 'get', store: 'worlds', key: id },
        { op: 'get', store: 'state', key: id },
        { op: 'get', store: 'history', key: id },
        { op: 'getAll', store: 'historySteps', range: worldRange(id) },
        { op: 'getAll', store: 'diffs', range: worldRange(id) },
      ])) as [unknown, unknown, unknown, { keys: (readonly [string, number])[]; values: unknown[] }, { keys: (readonly [string, number])[]; values: Uint8Array[] }];
      const p = parseWorldRecord(world);
      if (!p.ok || !isObj(state)) return null;
      return {
        world: p.world,
        state: state as unknown as StateRecord,
        history: assembleHistory(history, stepsOf(steps)),
        cols: diffs.keys.map((k, i) => ({ key: k[1], bytes: diffs.values[i]! })),
      };
    },
    writeAll(d) {
      return kv.write(copyOps(d.world, d.state, d.history === null ? null : wholeWrite(d.history), d.cols));
    },
  };
}

/**
 * The saved worlds over the connection `open` gives (§3.8, D14), or null when it cannot open: `open` throws or rejects
 * (`openIdbKV` with no `indexedDB`, blocked site data). Null is the spec's `saves.available()` false (ruling P36).
 */
export async function openSaves(open: () => Promise<KV>): Promise<Saves | null> {
  try {
    return createSaves(await open());
  } catch {
    return null;
  }
}

/**
 * One flush's batch (§3.2): each column's bytes under `[worldId, key]` (null bytes → its delete), the state, and the
 * history (`historyOps`: its new steps, the dropped ones' deletes and the index; SP5c D28's lever 3) and the `worlds`
 * record when given.
 */
export function flushOps(
  worldId: string,
  cols: readonly { key: number; bytes: Uint8Array | null }[],
  state: StateRecord,
  history: HistoryWrite | null,
  world: WorldRecord | null,
): WriteOp[] {
  const ops: WriteOp[] = cols.map((c): WriteOp =>
    c.bytes === null
      ? { op: 'delete', store: 'diffs', key: [worldId, c.key] }
      : { op: 'put', store: 'diffs', key: [worldId, c.key], value: c.bytes });
  ops.push({ op: 'put', store: 'state', key: worldId, value: state });
  if (history !== null) ops.push(...historyOps(worldId, history));
  if (world !== null) ops.push({ op: 'put', store: 'worlds', key: world.id, value: world });
  return ops;
}

/**
 * A whole world's batch under `world.id` (Import, the backup copy): the record, the state, the history when given (a
 * whole write: every step it names), every column.
 */
export function copyOps(
  world: WorldRecord,
  state: StateRecord,
  history: HistoryWrite | null,
  cols: readonly { key: number; bytes: Uint8Array }[],
): WriteOp[] {
  const ops: WriteOp[] = [
    { op: 'put', store: 'worlds', key: world.id, value: world },
    { op: 'put', store: 'state', key: world.id, value: state },
  ];
  if (history !== null) ops.push(...historyOps(world.id, history));
  for (const c of cols) ops.push({ op: 'put', store: 'diffs', key: [world.id, c.key], value: c.bytes });
  return ops;
}

// ---------------------------------------------------------------- the proposed names

/** "New world N", N ≥ 1 the smallest no world uses (D2). */
export function newWorldName(taken: readonly string[]): string {
  const used = new Set(taken);
  let n = 1;
  while (used.has(`New world ${n}`)) n++;
  return `New world ${n}`;
}

/**
 * "<name> (before the change)", then "<name> (before the change 2)", "… 3", the first no world uses (D11); `name` cut
 * so the whole is at most `MAX_NAME` code points (D2), the suffix kept.
 */
export function backupName(name: string, taken: readonly string[]): string {
  const used = new Set(taken);
  const chars = Array.from(name);
  const named = (suffix: string): string => `${chars.slice(0, Math.max(0, MAX_NAME - suffix.length)).join('')}${suffix}`;
  const first = named(' (before the change)');
  if (!used.has(first)) return first;
  let n = 2;
  while (used.has(named(` (before the change ${n})`))) n++;
  return named(` (before the change ${n})`);
}

/** The download's name (D15): every character outside letters, digits, space, `-` and `_` → `_`, plus `.wiworld`. */
export function exportFileName(name: string): string {
  return `${name.replace(/[^\p{L}\p{Nd} _-]/gu, '_')}.wiworld`;
}
