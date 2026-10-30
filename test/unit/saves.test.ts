/**
 * `saves.ts`' pure part (SP5b spec §2.1-§2.3, D22, D33): the saved params load over the profile and the committed
 * SP5b-era fixture, the `stateTable` relation and remap, the `worlds` record's shape check, the state and history
 * normaliser (one test per field of §2.1) and the older-generator check; and the records over the KV (§1.2, §1.3, §2.4,
 * D2, D11, D15, E7): the list, create, rename, delete, the export and import batches, the sim's batch builders and the
 * proposed names.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { WINDOW_HALF } from '../../src/core/coords';
import { fnv1a64, hex64, type Seed64 } from '../../src/core/hash';
import { canonicalJSON } from '../../src/core/params/canonical';
import { checkParams, diffParams } from '../../src/core/params/kit';
import type { JsonObject } from '../../src/core/params/migrate';
import { resolveProfile } from '../../src/core/params/profiles';
import { SCHEMA } from '../../src/core/params/schema';
import { genKey, stageHashes } from '../../src/core/stage/hash';
import { TIME_SPEEDS } from '../../src/daynight/dayNight';
import { WorldSession } from '../../src/engine/session';
import { worldRange, type KV, type ReadRequest } from '../../src/persist/kv';
import { createMemoryKV } from '../../src/persist/memory';
import {
  backupName, createSaves, DEFAULT_SPEED, DEFAULT_T, exportFileName, flushOps, HISTORY_STEPS, loadParams, MAX_NAME,
  MAX_PLACES, newState, newWorldName, NO_VALUE, normalizeHistory, normalizeState, olderGenerator, openSaves, parseWorldRecord,
  remapDiff, remapOf, remapValue, tableRelation, todayStateTable, type HistoryEdit, type HistoryRecord,
  type StateBounds, type StateRecord, type WorldRecord,
} from '../../src/persist/saves';
import { SPEED_MAX, SPEED_MIN } from '../../src/player/fly';
import { normalizeHotbar } from '../../src/player/hotbar';
import { NO_ENTRY } from '../../src/sim/diffStore';
import { Y_MAX, Y_MIN } from '../../src/ui/world/query';
import { REGISTRY } from '../../src/world/blocks';

const FIXTURE = new URL('../fixtures/sp5bWorldParams.json', import.meta.url);
const fixture = (): { schemaVersion: number; profile: 'default'; params: JsonObject } =>
  JSON.parse(readFileSync(FIXTURE, 'utf8')) as { schemaVersion: number; profile: 'default'; params: JsonObject };

/** The document without `density.defs` (a leaf a later SP adds, as the 1 → 2 migration assumes). */
const withoutDefs = (params: JsonObject): JsonObject => {
  const density = { ...(params['density'] as JsonObject) };
  delete density['defs'];
  return { ...params, density };
};

/** The UI's bounds (Task 10's `STATE_BOUNDS`), built here from the same sources. */
const BOUNDS: StateBounds = {
  normalizeHotbar: (r) => ({ v: 1, ...normalizeHotbar(r) }),
  timeSpeedCount: TIME_SPEEDS.length,
  speedMin: SPEED_MIN,
  speedMax: SPEED_MAX,
  xzLimit: WINDOW_HALF,
  yMin: Y_MIN,
  yMax: Y_MAX,
};

const WORLD = 'w1';
const stone = REGISTRY.parseStateKey('stone');
const goodPlayer = { x: 10.5, y: 80, z: -20.25, yaw: 90, pitch: -10, mode: 'walk', speed: 30 };
const goodPlace = (i: number): Record<string, unknown> => ({ id: `p${i}`, name: `Place ${i}`, colour: i % 8, x: i, y: 70, z: -i, yaw: 0, pitch: 0 });
const goodState = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  worldId: WORLD, flushSeq: 4, updated: 1_800_000_000_000, player: goodPlayer, time: { t: 0.4, speedIndex: 2 },
  hotbar: { v: 1, active: 3, slots: [] }, places: [goodPlace(1)], ...over,
});
const withPlayer = (over: Record<string, unknown>) => goodState({ player: { ...goodPlayer, ...over } });

const edit = (over: Partial<HistoryEdit> = {}): HistoryEdit => ({ x: 1, y: 64, z: 2, before: NO_VALUE, after: stone << 8, ...over });
const step = (over: Partial<HistoryEdit> = {}) => ({ edits: [edit(over)] });

describe('loadParams (D33)', () => {
  test('the committed SP5b-era fixture `sp5bWorldParams.json` (a complete default-profile document, `schemaVersion` 2) loads, and equals `resolveProfile(\'default\')`', () => {
    const f = fixture();
    expect(f.schemaVersion).toBe(2);
    const r = loadParams(f);
    expect(r.ok, r.ok ? '' : JSON.stringify(r.issues)).toBe(true);
    if (r.ok) expect(canonicalJSON(r.value)).toBe(canonicalJSON(resolveProfile('default')));
  });

  test('the fixture with `density.defs` removed loads with the profile\'s `density.defs` (a leaf a later SP adds), where `checkParams` refuses it with `MISSING_KEY`', () => {
    const params = withoutDefs(fixture().params);
    const checked = checkParams(SCHEMA, params);
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.issues).toContainEqual(expect.objectContaining({ path: 'density.defs', code: 'MISSING_KEY' }));
    const r = loadParams({ params, schemaVersion: 2, profile: 'default' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(canonicalJSON(r.value.density.defs)).toBe(canonicalJSON(resolveProfile('default').density.defs));
      expect(canonicalJSON(r.value)).toBe(canonicalJSON(resolveProfile('default')));
    }
  });

  test('an amplified world missing a leaf takes amplified\'s value, not the default\'s', () => {
    const amplified = resolveProfile('amplified');
    const params = withoutDefs(JSON.parse(canonicalJSON(amplified)) as JsonObject);
    const r = loadParams({ params, schemaVersion: 2, profile: 'amplified' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(canonicalJSON(r.value.density.defs)).toBe(canonicalJSON(amplified.density.defs));
      expect(canonicalJSON(r.value.density.defs)).not.toBe(canonicalJSON(resolveProfile('default').density.defs));
    }
  });

  test('`schemaVersion` 3 → a `MIGRATION_FAILED` issue', () => {
    const r = loadParams({ ...fixture(), schemaVersion: 3 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.map((i) => i.code)).toContain('MIGRATION_FAILED');
  });

  test('an unknown or unready profile → an issue', () => {
    for (const profile of ['nope', 'cave_heavy'] as const) {
      const r = loadParams({ ...fixture(), profile: profile as 'default' });
      expect(r.ok, profile).toBe(false);
      if (!r.ok) expect(r.issues[0]!.path).toBe('profile');
    }
  });
});

describe('the stateTable remap (D22, §2.3)', () => {
  const today = todayStateTable();
  const permuted = [...today].reverse();
  const withUnknown = [...permuted.slice(0, 10), 'nope[x=1]', ...permuted.slice(10)];

  test('today\'s table is `stateKey(s)` for every state', () => {
    expect(today.length).toBe(REGISTRY.stateCount);
    today.forEach((k, s) => expect(REGISTRY.parseStateKey(k)).toBe(s));
  });

  test('`tableRelation`: today\'s table `\'equal\'`, its first 55 keys `\'prefix\'`, a permutation `\'other\'`', () => {
    expect(tableRelation(today)).toBe('equal');
    expect(tableRelation(today.slice(0, 55))).toBe('prefix');
    expect(tableRelation(permuted)).toBe('other');
    expect(tableRelation([...today, 'nope[x=1]'])).toBe('other');
  });

  test('`remapOf` of a permuted table with one unknown key `nope[x=1]`: every known key maps to its id, the unknown to −1, `unknownKeys` 1', () => {
    const { to, unknownKeys } = remapOf(withUnknown);
    expect(to.length).toBe(withUnknown.length);
    expect(unknownKeys).toBe(1);
    withUnknown.forEach((k, i) => expect(to[i], k).toBe(k === 'nope[x=1]' ? -1 : REGISTRY.parseStateKey(k)));
  });

  test('`remapValue(5 << 8 | 3, to)` keeps the fluid byte; an unknown → 0 with `unknown` true; `NO_VALUE` kept', () => {
    const { to } = remapOf(withUnknown);
    expect(remapValue(5 << 8 | 3, to)).toEqual({ value: (to[5]! << 8 | 3) >>> 0, unknown: false });
    expect(to[5]).toBe(REGISTRY.parseStateKey(withUnknown[5]!));
    expect(remapValue(10 << 8 | 7, to)).toEqual({ value: 0, unknown: true });
    expect(remapValue(NO_VALUE, to)).toEqual({ value: NO_VALUE, unknown: false });
    expect(NO_VALUE).toBe(NO_ENTRY);
  });

  test('`remapDiff` remaps every value, keeps `sy` and `idx`, and counts the unknowns', () => {
    const { to } = remapOf(withUnknown);
    const d = { sy: Uint8Array.of(0, 0, 5), idx: Uint16Array.of(1, 9, 4095), value: Uint32Array.of(2 << 8, 10 << 8 | 1, 3 << 8 | 127) };
    const r = remapDiff(d, to);
    expect([...r.diff.sy]).toEqual([0, 0, 5]);
    expect([...r.diff.idx]).toEqual([1, 9, 4095]);
    expect([...r.diff.value]).toEqual([to[2]! << 8, 0, to[3]! << 8 | 127]);
    expect(r.unknown).toBe(1);
    expect(r.diff.value).not.toBe(d.value);
  });
});

describe('normalizeState (§2.1)', () => {
  const norm = (raw: unknown) => normalizeState(raw, WORLD, BOUNDS);

  test('a well-formed record passes unchanged, its hotbar through the bounds\' `normalizeHotbar`', () => {
    const { state, reset } = norm(goodState());
    expect(reset).toBe(false);
    expect(state).toEqual({ ...goodState(), hotbar: BOUNDS.normalizeHotbar({ v: 1, active: 3, slots: [] }) });
    expect(state.hotbar.active).toBe(3);
  });

  test('a `NaN` x → `player: null`', () => {
    expect(norm(withPlayer({ x: Number.NaN })).state.player).toBeNull();
  });

  test('a y outside [yMin, yMax] → `player: null`; at the bounds kept', () => {
    expect(norm(withPlayer({ y: Y_MAX + 1 })).state.player).toBeNull();
    expect(norm(withPlayer({ y: Y_MIN - 0.5 })).state.player).toBeNull();
    expect(norm(withPlayer({ y: Y_MAX })).state.player?.y).toBe(Y_MAX);
    expect(norm(withPlayer({ y: Y_MIN })).state.player?.y).toBe(Y_MIN);
  });

  test('a player at x 510,000 (beyond `AT_LIMIT`, inside `WINDOW_HALF`) kept, one at x 2^19 → `player: null`', () => {
    expect(norm(withPlayer({ x: 510_000 })).state.player?.x).toBe(510_000);
    expect(norm(withPlayer({ z: -510_000 })).state.player?.z).toBe(-510_000);
    expect(norm(withPlayer({ x: 2 ** 19 })).state.player).toBeNull();
    expect(norm(withPlayer({ z: 2 ** 19 })).state.player).toBeNull();
  });

  test('yaw and pitch any finite value; a non-finite one → `player: null`', () => {
    expect(norm(withPlayer({ yaw: 1234.5, pitch: -300 })).state.player).toMatchObject({ yaw: 1234.5, pitch: -300 });
    expect(norm(withPlayer({ yaw: Infinity })).state.player).toBeNull();
    expect(norm(withPlayer({ pitch: '3' })).state.player).toBeNull();
  });

  test('`speed` 0 and 97 → 12', () => {
    expect(DEFAULT_SPEED).toBe(12);
    expect(norm(withPlayer({ speed: 0 })).state.player?.speed).toBe(12);
    expect(norm(withPlayer({ speed: 97 })).state.player?.speed).toBe(12);
    expect(norm(withPlayer({ speed: Number.NaN })).state.player?.speed).toBe(12);
    expect(norm(withPlayer({ speed: 1.5625 })).state.player?.speed).toBe(1.5625);
  });

  test('`mode: \'swim\'` → `\'fly\'`', () => {
    expect(norm(withPlayer({ mode: 'swim' })).state.player?.mode).toBe('fly');
    expect(norm(withPlayer({ mode: 'walk' })).state.player?.mode).toBe('walk');
  });

  test('a player that is not a record → null', () => {
    expect(norm(goodState({ player: 'here' })).state.player).toBeNull();
    expect(norm(goodState({ player: null })).state.player).toBeNull();
  });

  test('`t` 1 → 1/12', () => {
    expect(DEFAULT_T).toBe(1 / 12);
    expect(norm(goodState({ time: { t: 1, speedIndex: 2 } })).state.time).toEqual({ t: 1 / 12, speedIndex: 2 });
    expect(norm(goodState({ time: { t: -0.1, speedIndex: 2 } })).state.time.t).toBe(1 / 12);
    expect(norm(goodState({ time: { t: 0, speedIndex: 2 } })).state.time.t).toBe(0);
  });

  test('`speedIndex` 4 → 0', () => {
    expect(norm(goodState({ time: { t: 0.4, speedIndex: 4 } })).state.time).toEqual({ t: 0.4, speedIndex: 0 });
    expect(norm(goodState({ time: { t: 0.4, speedIndex: 1.5 } })).state.time.speedIndex).toBe(0);
    expect(norm(goodState({ time: { t: 0.4, speedIndex: 3 } })).state.time.speedIndex).toBe(3);
  });

  test('`flushSeq` a non-negative integer, else 0; `updated` a finite non-negative number, else 0', () => {
    expect(norm(goodState({ flushSeq: -1 })).state.flushSeq).toBe(0);
    expect(norm(goodState({ flushSeq: 2.5 })).state.flushSeq).toBe(0);
    expect(norm(goodState({ flushSeq: 9 })).state.flushSeq).toBe(9);
    expect(norm(goodState({ updated: Number.NaN })).state.updated).toBe(0);
  });

  test('`pitch: -0` → 0 and the record passes `canonicalJSON`', () => {
    const { state } = norm(goodState({
      player: { ...goodPlayer, pitch: -0, yaw: -0 }, time: { t: -0, speedIndex: 0 }, flushSeq: -0, updated: -0,
      places: [{ ...goodPlace(1), x: -0, yaw: -0, pitch: -0 }],
    }));
    expect(Object.is(state.player!.pitch, 0)).toBe(true);
    expect(Object.is(state.player!.yaw, 0)).toBe(true);
    expect(Object.is(state.time.t, 0)).toBe(true);
    expect(Object.is(state.places[0]!.x, 0)).toBe(true);
    expect(() => canonicalJSON(state)).not.toThrow();
  });

  test('300 places → 256', () => {
    expect(MAX_PLACES).toBe(256);
    const places = Array.from({ length: 300 }, (_, i) => goodPlace(i));
    const kept = norm(goodState({ places })).state.places;
    expect(kept.length).toBe(256);
    expect(kept[255]!.id).toBe('p255');
  });

  test('a colour 8 dropped', () => {
    const places = [goodPlace(1), { ...goodPlace(2), colour: 8 }, { ...goodPlace(3), colour: 1.5 }, goodPlace(4)];
    expect(norm(goodState({ places })).state.places.map((p) => p.id)).toEqual(['p1', 'p4']);
  });

  test('a 70-character name cut to 64', () => {
    expect(MAX_NAME).toBe(64);
    const name = 'n'.repeat(70);
    expect(norm(goodState({ places: [{ ...goodPlace(1), name }] })).state.places[0]!.name).toBe('n'.repeat(64));
  });

  test('a place with a bad coordinate (the player\'s bounds) dropped, as is one that is not a place', () => {
    const places = [
      { ...goodPlace(1), x: 2 ** 19 }, { ...goodPlace(2), y: Y_MAX + 1 }, { ...goodPlace(3), z: Number.NaN },
      { ...goodPlace(4), id: 4 }, { ...goodPlace(5), name: null }, 'p6', { ...goodPlace(7), x: 510_000 },
    ];
    expect(norm(goodState({ places })).state.places.map((p) => p.id)).toEqual(['p7']);
  });

  test('a string record → defaults with `reset` true', () => {
    const r = norm('{"worldId":"w1"}');
    expect(r.reset).toBe(true);
    expect(r.state).toEqual(newState(WORLD, BOUNDS));
  });

  test('the record\'s own `worldId` is replaced by the one it is read for', () => {
    expect(norm(goodState({ worldId: 'other' })).state.worldId).toBe(WORLD);
  });

  test('`newState`: no player, 08:00 at ×1, the default hotbar, no places, `flushSeq` 0, `updated` 0', () => {
    expect(newState(WORLD, BOUNDS)).toEqual({
      worldId: WORLD, flushSeq: 0, updated: 0, player: null, time: { t: 1 / 12, speedIndex: 0 },
      hotbar: BOUNDS.normalizeHotbar(null), places: [],
    });
  });
});

describe('normalizeHistory (§2.1)', () => {
  const history = (done: unknown[], undone: unknown[] = []) => ({ worldId: WORLD, done, undone });

  test('a well-formed history passes unchanged', () => {
    const raw = history([step(), step({ before: stone << 8 | 3, after: NO_VALUE })], [step({ x: -5 })]);
    const r = normalizeHistory(raw, WORLD, null);
    expect(r).toEqual({ history: raw, reset: false, dropped: 0 });
  });

  test('a step with `y` 320, one with `x` 2^19, one with a state 4095 dropped and counted', () => {
    expect(REGISTRY.stateCount).toBeLessThan(4095);
    const raw = history([step(), step({ y: 320 }), step({ x: 2 ** 19 }), step({ after: 4095 << 8 }), step({ y: -65 }), step({ z: 1.5 })], [step({ before: 4095 << 8 })]);
    const r = normalizeHistory(raw, WORLD, null);
    expect(r.history.done).toEqual([step()]);
    expect(r.history.undone).toEqual([]);
    expect(r.dropped).toBe(6);
    expect(r.reset).toBe(false);
  });

  test('a step with any bad edit is dropped whole', () => {
    const raw = history([{ edits: [edit(), edit({ y: 320 })] }, { edits: 'x' }, { edits: [] }, 7]);
    const r = normalizeHistory(raw, WORLD, null);
    expect(r.history.done).toEqual([]);
    expect(r.dropped).toBe(4);
  });

  test('120 done steps → the newest 100', () => {
    expect(HISTORY_STEPS).toBe(100);
    const done = Array.from({ length: 120 }, (_, i) => step({ x: i }));
    const r = normalizeHistory(history(done, done), WORLD, null);
    expect(r.history.done.length).toBe(100);
    expect(r.history.done[0]).toEqual(step({ x: 20 }));
    expect(r.history.done[99]).toEqual(step({ x: 119 }));
    expect(r.history.undone.length).toBe(100);
    expect(r.dropped).toBe(40);
  });

  test('each value is remapped through `to` when given: an unknown state becomes air, a state past the stored table drops the step', () => {
    const stored = [...todayStateTable()].reverse();
    stored.push('nope[x=1]');
    const { to } = remapOf(stored);
    const unknownId = stored.length - 1;
    const raw = history([step({ before: 2 << 8 | 1, after: NO_VALUE }), step({ after: unknownId << 8 }), step({ after: stored.length << 8 })]);
    const r = normalizeHistory(raw, WORLD, to);
    expect(r.history.done).toEqual([step({ before: (to[2]! << 8 | 1) >>> 0, after: NO_VALUE }), step({ after: 0 })]);
    expect(r.dropped).toBe(1);
  });

  test('−0 coordinates become 0', () => {
    const r = normalizeHistory(history([step({ x: -0, z: -0 })]), WORLD, null);
    expect(Object.is(r.history.done[0]!.edits[0]!.x, 0)).toBe(true);
    expect(() => canonicalJSON(r.history)).not.toThrow();
  });

  test('`normalizeHistory(undefined, …)` → empty with `reset` false; `normalizeHistory(7, …)` → empty with `reset` true', () => {
    expect(normalizeHistory(undefined, WORLD, null)).toEqual({ history: { worldId: WORLD, done: [], undone: [] }, reset: false, dropped: 0 });
    expect(normalizeHistory(7, WORLD, null)).toEqual({ history: { worldId: WORLD, done: [], undone: [] }, reset: true, dropped: 0 });
  });
});

describe('parseWorldRecord', () => {
  const good = (): WorldRecord => {
    const f = fixture();
    const params = loadParams(f);
    if (!params.ok) throw new Error('fixture');
    return {
      id: 'w1', name: 'My world', seedText: 'hello', seed: [1, 2], profile: 'default', params: f.params, schemaVersion: 2,
      paramsHash: '0123456789abcdef', generatorVersion: 5, genKey: hex64(genKey([1, 2], stageHashes(params.value))),
      stateTable: todayStateTable(), created: 1_800_000_000_000, backupOf: null,
    };
  };

  test('a well-formed record → ok, with `backupOf` a string or null', () => {
    const r = parseWorldRecord(good());
    expect(r).toEqual({ ok: true, world: good() });
    expect(parseWorldRecord({ ...good(), backupOf: 'w0' }).ok).toBe(true);
  });

  test('a value that is not a record → not ok', () => {
    expect(parseWorldRecord('w1').ok).toBe(false);
    expect(parseWorldRecord(null).ok).toBe(false);
  });

  const wrong: [field: keyof WorldRecord, value: unknown][] = [
    ['id', 7], ['name', null], ['seedText', 1], ['seed', [1]], ['seed', [1, 2 ** 32]], ['seed', [1.5, 2]], ['profile', 'nope'],
    ['params', []], ['params', 'x'], ['schemaVersion', 1.5], ['paramsHash', '0123456789ABCDEF'], ['paramsHash', 'abc'],
    ['generatorVersion', '5'], ['genKey', '0123456789abcdeg'], ['stateTable', ['air', 1]], ['stateTable', 'air'],
    ['created', Number.NaN], ['backupOf', 3], ['backupOf', undefined],
  ];
  test.each(wrong)('a wrong `%s` (%j) → `{ok: false}` naming it', (field, value) => {
    const r = parseWorldRecord({ ...good(), [field]: value });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain(field);
  });
});

describe('olderGenerator (D8)', () => {
  const seed: Seed64 = [0x1234, 0x5678];
  const record = (key: string): WorldRecord => ({
    id: 'w1', name: 'n', seedText: 's', seed: [seed[0], seed[1]], profile: 'default', params: fixture().params, schemaVersion: 2,
    paramsHash: '0123456789abcdef', generatorVersion: 5, genKey: key, stateTable: todayStateTable(), created: 1, backupOf: null,
  });

  test('`olderGenerator` false for a record written by today\'s code, true for one whose `genKey` came from `GENERATOR_VERSION` 4\'s formula', () => {
    const p = loadParams(fixture());
    if (!p.ok) throw new Error('fixture');
    const h = stageHashes(p.value);
    expect(olderGenerator(record(hex64(genKey(seed, h))), p.value)).toBe(false);
    const v4 = hex64(fnv1a64(`4|${seed[0]}|${seed[1]}|${hex64(h.decorate!)}`));
    expect(olderGenerator(record(v4), p.value)).toBe(true);
  });

  test('(D33/§1.3) the badge and the page agree on the fixture missing `density.defs`: `olderGenerator` uses `loadParams`\' params, and their genKey equals the session\'s', () => {
    const f = fixture();
    const p = loadParams({ params: withoutDefs(f.params), schemaVersion: 2, profile: 'default' });
    if (!p.ok) throw new Error('fixture');
    const session = new WorldSession(() => [9, 9], { seedText: 'hello', profile: 'default', patch: diffParams(SCHEMA, resolveProfile('default'), p.value) });
    const s = session.state;
    const pageKey = hex64(genKey(s.seed, stageHashes(s.params)));
    const w = { ...record(pageKey), seedText: 'hello', seed: [s.seed[0], s.seed[1]] as [number, number], params: withoutDefs(f.params) };
    expect(hex64(genKey(w.seed, stageHashes(p.value)))).toBe(pageKey);
    expect(olderGenerator(w, p.value)).toBe(false);
  });
});

describe('saves over the KV (§1.2, §1.3, §2.4, E7)', () => {
  const key = (() => {
    const p = loadParams(fixture());
    if (!p.ok) throw new Error('fixture');
    return hex64(genKey([1, 2], stageHashes(p.value)));
  })();
  const world = (id: string, over: Partial<WorldRecord> = {}): WorldRecord => ({
    id, name: `World ${id}`, seedText: 'hello', seed: [1, 2], profile: 'default', params: fixture().params, schemaVersion: 2,
    paramsHash: '0123456789abcdef', generatorVersion: 5, genKey: key, stateTable: todayStateTable(), created: 1_000, backupOf: null,
    ...over,
  });
  const state = (id: string, over: Partial<StateRecord> = {}): StateRecord => ({ ...newState(id, BOUNDS), ...over });
  const history = (id: string): HistoryRecord => ({ worldId: id, done: [step()], undone: [] });
  const bytes = (...b: number[]) => new Uint8Array(b);
  const COMPLETE = { status: 'complete', errorName: null };

  /** Two worlds, each with its three records and three columns, written through `copyOps` (`writeAll`). */
  async function twoWorlds() {
    const kv = createMemoryKV();
    const saves = createSaves(kv);
    for (const id of ['a', 'b']) {
      const cols = [3, 1, 2 ** 32 - 1].map((k) => ({ key: k, bytes: bytes(k & 0xFF, id.charCodeAt(0)) }));
      expect(await saves.writeAll({ world: world(id), state: state(id, { updated: 5_000 }), history: history(id), cols })).toEqual(COMPLETE);
    }
    return { kv, saves };
  }

  /** The KV with every `read`'s requests recorded. */
  const spyReads = (kv: KV) => {
    const reads: (readonly ReadRequest[])[] = [];
    const spy: KV = { read: (reqs) => (reads.push(reqs), kv.read(reqs)), write: kv.write, onEvent: kv.onEvent, close: kv.close };
    return { spy, reads };
  };

  /** Every key of the KV, by store. */
  const allKeys = (kv: ReturnType<typeof createMemoryKV>) =>
    (['worlds', 'state', 'history', 'diffs', 'meta'] as const).map((s) => [s, kv.dump(s).map(([k]) => k)]);

  test('`list` orders by `updated` descending, a never-saved world by `created` (its row\'s `updated` is `created`); ties by id', async () => {
    const kv = createMemoryKV();
    const saves = createSaves(kv);
    await saves.create(world('old', { created: 1_000 }), state('old', { updated: 2_000 }));
    await saves.create(world('new', { created: 3_000 }), state('new'));
    await saves.create(world('tie2', { created: 1 }), state('tie2', { updated: 2_500 }));
    await saves.create(world('tie1', { created: 2 }), state('tie1', { updated: 2_500, places: [goodPlace(1), goodPlace(2)] as unknown as StateRecord['places'] }));
    const rows = await saves.list();
    expect(rows.map((r) => (r.broken ? r.id : r.world.id))).toEqual(['new', 'tie1', 'tie2', 'old']);
    expect(rows[0]).toEqual({ broken: false, world: world('new', { created: 3_000 }), updated: 3_000, places: 0 });
    expect(rows[1]).toMatchObject({ broken: false, updated: 2_500, places: 2 });
  });

  test('`list` makes one `read` and never touches `diffs` or `history` (a spy KV)', async () => {
    const { kv } = await twoWorlds();
    const { spy, reads } = spyReads(kv);
    const rows = await createSaves(spy).list();
    expect(rows).toHaveLength(2);
    expect(reads).toHaveLength(1);
    expect(reads[0]!.map((r) => r.store).sort()).toEqual(['state', 'worlds']);
    expect(reads[0]!.every((r) => r.op === 'getAll' && r.range === null)).toBe(true);
  });

  test('a `worlds` record with a non-string `name` is listed as a broken row with `parseWorldRecord`\'s reason', async () => {
    const kv = createMemoryKV();
    const saves = createSaves(kv);
    await saves.create(world('good'), state('good'));
    await kv.write([{ op: 'put', store: 'worlds', key: 'bad', value: { ...world('bad'), name: 7 } }]);
    const rows = await saves.list();
    const reason = parseWorldRecord({ ...world('bad'), name: 7 });
    expect(reason.ok).toBe(false);
    expect(rows).toContainEqual({ broken: true, id: 'bad', reason: reason.ok ? '' : reason.reason });
    expect(rows).toContainEqual(expect.objectContaining({ broken: false, world: world('good') }));
  });

  test('`create` then `readOpen` returns both records; `history` undefined', async () => {
    const kv = createMemoryKV();
    const saves = createSaves(kv);
    expect(await saves.create(world('w'), state('w'))).toEqual(COMPLETE);
    expect(kv.opCount).toBe(2);
    expect(await saves.readOpen('w')).toEqual({ world: world('w'), state: state('w'), history: undefined });
    expect(await saves.readOpen('nope')).toEqual({ world: undefined, state: undefined, history: undefined });
  });

  test('rename trims and cuts to 64; an empty name is refused', async () => {
    const kv = createMemoryKV();
    const saves = createSaves(kv);
    await saves.create(world('w'), state('w'));
    expect(await saves.rename('w', `  ${'é'.repeat(70)}  `)).toEqual(COMPLETE);
    expect((await saves.readOpen('w')).world).toEqual(world('w', { name: 'é'.repeat(MAX_NAME) }));
    expect(await saves.rename('w', '  Home \t')).toEqual(COMPLETE);
    expect((await saves.readOpen('w')).world).toEqual(world('w', { name: 'Home' }));
    const ops = kv.opCount;
    expect(await saves.rename('w', ' \t ')).toEqual({ status: 'abort', errorName: 'EmptyName' });
    expect(kv.opCount).toBe(ops);
    expect((await saves.readOpen('w')).world).toEqual(world('w', { name: 'Home' }));
  });

  test('`remove` leaves no key of the world in any store, and another world\'s keys untouched (E7\'s `deleteLeftovers` in small)', async () => {
    const { kv, saves } = await twoWorlds();
    const before = allKeys(kv);
    expect(await saves.remove('a')).toEqual(COMPLETE);
    const after = allKeys(kv);
    const ofA = (k: unknown) => k === 'a' || (Array.isArray(k) && k[0] === 'a');
    expect(after).toEqual(before.map(([s, keys]) => [s, (keys as unknown[]).filter((k) => !ofA(k))]));
    expect(kv.dump('diffs')).toHaveLength(3);
    expect(await saves.readAll('b')).not.toBeNull();
  });

  test('a `failAt(2)` during `remove` leaves every key', async () => {
    const { kv, saves } = await twoWorlds();
    const before = allKeys(kv);
    kv.failAt(2);
    expect(await saves.remove('a')).toEqual({ status: 'abort', errorName: 'AbortError' });
    expect(allKeys(kv)).toEqual(before);
  });

  test('`readAll` returns the diffs in colKey order', async () => {
    const { kv, saves } = await twoWorlds();
    const { spy, reads } = spyReads(kv);
    const d = await createSaves(spy).readAll('a');
    expect(reads).toHaveLength(1);
    expect(d).toEqual({
      world: world('a'), state: state('a', { updated: 5_000 }), history: history('a'),
      cols: [1, 3, 2 ** 32 - 1].map((k) => ({ key: k, bytes: bytes(k & 0xFF, 'a'.charCodeAt(0)) })),
    });
    expect(await saves.readAll('nope')).toBeNull();
    await saves.create(world('c'), state('c'));
    expect(await saves.readAll('c')).toEqual({ world: world('c'), state: state('c'), history: null, cols: [] });
  });

  test('`flushOps` with a null column deletes its key', async () => {
    const kv = createMemoryKV();
    await kv.write(flushOps('w', [{ key: 1, bytes: bytes(1) }, { key: 2, bytes: bytes(2) }], state('w', { flushSeq: 1 }), history('w'), world('w')));
    const ops = flushOps('w', [{ key: 1, bytes: null }, { key: 3, bytes: bytes(3) }], state('w', { flushSeq: 2 }), null, null);
    expect(ops).toContainEqual({ op: 'delete', store: 'diffs', key: ['w', 1] });
    expect(ops.some((o) => o.store === 'history' || o.store === 'worlds')).toBe(false);
    expect(await kv.write(ops)).toEqual(COMPLETE);
    expect(kv.dump('diffs')).toEqual([[['w', 2], bytes(2)], [['w', 3], bytes(3)]]);
    expect(kv.dump('state')).toEqual([['w', state('w', { flushSeq: 2 })]]);
    expect(kv.dump('history')).toEqual([['w', history('w')]]);
    expect(kv.dump('worlds')).toEqual([['w', world('w')]]);
    expect(worldRange('w')).toEqual({ lower: ['w', 0], upper: ['w', 2 ** 32] });
  });

  test('`newWorldName` with "New world 1", "New world 3" taken → "New world 2"', () => {
    expect(newWorldName(['New world 1', 'New world 3'])).toBe('New world 2');
    expect(newWorldName([])).toBe('New world 1');
  });

  test('`backupName(\'My world\', [\'My world (before the change)\'])` → "My world (before the change 2)"', () => {
    expect(backupName('My world', ['My world (before the change)'])).toBe('My world (before the change 2)');
    expect(backupName('My world', [])).toBe('My world (before the change)');
    expect(backupName('My world', ['My world (before the change)', 'My world (before the change 2)'])).toBe('My world (before the change 3)');
  });

  test('`exportFileName(\'a/b:c é\')` → `a_b_c é.wiworld` (letters include non-ASCII letters)', () => {
    expect(exportFileName('a/b:c é')).toBe('a_b_c é.wiworld');
    expect(exportFileName('My-world_2 ¿?')).toBe('My-world_2 __.wiworld');
  });
});

describe('openSaves (§3.8, D14; ruling P36)', () => {
  test('`openSaves` of a throwing or rejecting `open` → null; of a resolving one → a `Saves` over that KV', async () => {
    expect(await openSaves(() => { throw new ReferenceError('indexedDB is not defined'); })).toBeNull();
    expect(await openSaves(() => Promise.reject(new Error('blocked site data')))).toBeNull();
    const kv = createMemoryKV();
    const saves = await openSaves(() => Promise.resolve(kv));
    expect(saves).not.toBeNull();
    expect(saves!.kv).toBe(kv);
    expect(await saves!.list()).toEqual([]);
  });
});
