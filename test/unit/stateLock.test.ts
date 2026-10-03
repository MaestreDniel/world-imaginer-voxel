import { describe, expect, test } from 'vitest';
import { BLOCK_DEFS } from '../../src/world/blocks/defs';
import { buildRegistry, type BlockDef, type PropertyDef } from '../../src/world/blocks/registry';
import { AIR_TABLES, FIXTURE_DEFS, FIXTURE_STATE_COUNT, SOLID_TABLES } from '../harness/blockFixtures';
import {
  acceptStateIds, lockFormatErrors, lockTypeName, readStateLock, registryStateIds, stateLockViolations, type StateIdLock,
} from '../harness/stateLock';

const FIXTURE = buildRegistry(FIXTURE_DEFS);
const FIXTURE_LOCK: StateIdLock = registryStateIds(FIXTURE);
const prop = (name: string, kind: PropertyDef['kind'], def: string): PropertyDef => ({ name, kind, default: def });
const without = (name: string): BlockDef[] => FIXTURE_DEFS.filter((d) => d.name !== name);
const refusals = (lock: StateIdLock | null, defs: readonly BlockDef[]): string[] => {
  const r = acceptStateIds(lock, buildRegistry(defs));
  return r.ok ? [] : r.errors;
};

describe('the lock format (SP3a spec §2.3)', () => {
  test('a lock maps every canonical key to its id, in id order', () => {
    const keys = Object.keys(FIXTURE_LOCK);
    expect(keys).toHaveLength(FIXTURE_STATE_COUNT);
    expect(Object.values(FIXTURE_LOCK)).toEqual(Array.from({ length: FIXTURE_STATE_COUNT }, (_, i) => i));
    expect(keys.slice(0, 4)).toEqual(['air', 'log[axis=y]', 'log[axis=x]', 'log[axis=z]']);
    expect(FIXTURE_LOCK['door[facing=north,half=bottom,open=false,hinge=left]']).toBe(FIXTURE.stateOf(FIXTURE.typeId('door')));
    expect(lockFormatErrors(FIXTURE_LOCK)).toEqual([]);
  });

  test('lockTypeName is the bare name or the part before [', () => {
    expect(lockTypeName('stone')).toBe('stone');
    expect(lockTypeName('door[facing=north,half=bottom,open=false,hinge=left]')).toBe('door');
  });

  test('malformed locks are reported', () => {
    expect(lockFormatErrors([])).toEqual(['the lock is not a JSON object of key → id']);
    expect(lockFormatErrors(null)).toEqual(['the lock is not a JSON object of key → id']);
    expect(lockFormatErrors({ air: 0, stone: 0 })).toEqual(['stone: id 0 is also air']);
    expect(lockFormatErrors({ air: 1.5 })).toEqual(['air: id 1.5 is not a u16']);
    expect(lockFormatErrors({ air: '0' })).toEqual(['air: id "0" is not a u16']);
    expect(lockFormatErrors({ 'log[axis = y]': 0 })).toEqual(['"log[axis = y]" is not a canonical state key']);
    expect(lockFormatErrors({ 'Stone': 0 })).toEqual(['"Stone" is not a canonical state key']);
  });

  test('a missing lock fails the lock test; accepting creates it with every state', () => {
    expect(stateLockViolations(null, FIXTURE)).toEqual(['test/stateIds.lock.json is missing: run npm run test:accept-state-ids']);
    const r = acceptStateIds(null, FIXTURE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.next).toEqual(FIXTURE_LOCK);
    expect(Object.keys(r.next)).toEqual(Object.keys(FIXTURE_LOCK));
    expect(r.appended).toEqual(Object.keys(FIXTURE_LOCK));
  });
});

describe('the append-only rule on a fixture copy (SP3a spec §2.3, §2.4)', () => {
  test('an unchanged registry passes, and accepting it appends nothing', () => {
    expect(stateLockViolations(FIXTURE_LOCK, FIXTURE)).toEqual([]);
    const r = acceptStateIds(FIXTURE_LOCK, FIXTURE);
    expect(r).toEqual({ ok: true, next: FIXTURE_LOCK, appended: [] });
  });

  test('a new type appended at the end fails the lock test until accepted; accepting appends only its states', () => {
    const defs = [...FIXTURE_DEFS, { name: 'lever', props: [prop('face', 'facing6', 'up')], ...SOLID_TABLES }];
    const reg = buildRegistry(defs);
    const added = ['up', 'north', 'east', 'south', 'west', 'down'].map((f) => `lever[face=${f}]`);
    expect(stateLockViolations(FIXTURE_LOCK, reg)).toEqual([`states not yet in the lock (${added.join(', ')}): run npm run test:accept-state-ids`]);
    const r = acceptStateIds(FIXTURE_LOCK, reg);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.appended).toEqual(added);
    expect(Object.keys(r.next)).toEqual([...Object.keys(FIXTURE_LOCK), ...added]);
    expect(added.map((k) => r.next[k])).toEqual([61, 62, 63, 64, 65, 66]);
    for (const [k, id] of Object.entries(FIXTURE_LOCK)) expect(r.next[k], k).toBe(id);
    expect(stateLockViolations(r.next, reg)).toEqual([]);
  });

  test('a changed id is refused (a type inserted before locked ones)', () => {
    const defs = [...FIXTURE_DEFS.slice(0, 1), { name: 'dirt', ...SOLID_TABLES }, ...FIXTURE_DEFS.slice(1)];
    const errors = refusals(FIXTURE_LOCK, defs);
    expect(errors).toHaveLength(FIXTURE_STATE_COUNT - 1);
    expect(errors[0]).toBe('log[axis=y] is id 2, locked as 1: locked ids never change (append new types at the end)');
    expect(stateLockViolations(FIXTURE_LOCK, buildRegistry(defs))).toEqual([...errors, 'states not yet in the lock (dirt): run npm run test:accept-state-ids']);
  });

  test('a changed id is refused (two types swapped)', () => {
    const defs = [...FIXTURE_DEFS];
    [defs[1], defs[2]] = [defs[2]!, defs[1]!];
    const errors = refusals(FIXTURE_LOCK, defs);
    expect(errors).toContain('log[axis=y] is id 5, locked as 1: locked ids never change (append new types at the end)');
    expect(errors).toContain('chest[facing=north] is id 1, locked as 4: locked ids never change (append new types at the end)');
    expect(errors).toHaveLength(7);
  });

  test('a removed entry is refused (a locked type removed from the registry)', () => {
    const errors = refusals(FIXTURE_LOCK, without('door'));
    expect(errors).toHaveLength(32);
    expect(errors[0]).toBe('door[facing=north,half=bottom,open=false,hinge=left] (id 29) is no longer registered: a locked state never goes away');
    expect(stateLockViolations(FIXTURE_LOCK, buildRegistry(without('door')))).toEqual(errors);
  });

  test('a new value on a locked type is refused (its property moves to a kind with more values)', () => {
    const lever = (kind: PropertyDef['kind']): BlockDef => ({ name: 'lever', props: [prop('face', kind, 'bottom')], ...SOLID_TABLES });
    const lock = registryStateIds(buildRegistry([...FIXTURE_DEFS, lever('half')]));
    // half (bottom, top) → slabType (bottom, top, double): the two locked states keep their keys and ids.
    const errors = refusals(lock, [...FIXTURE_DEFS, lever('slabType')]);
    expect(errors).toEqual([
      'lever[face=double] (id 63) is a new state of the locked type lever: a locked type never gains properties or values (append a new type; withType converts)',
    ]);
  });

  test('a new property on a locked type is refused', () => {
    const door = FIXTURE_DEFS.find((d) => d.name === 'door')!;
    const errors = refusals(FIXTURE_LOCK, [...without('door'), { ...door, props: [...door.props!, prop('powered', 'open', 'false')] }]);
    expect(errors.filter((e) => e.includes('no longer registered'))).toHaveLength(32);
    expect(errors.filter((e) => e.includes('new state of the locked type door'))).toHaveLength(64);
  });

  test('an entry deleted from the lock file is not re-appended', () => {
    const lock = { ...FIXTURE_LOCK };
    delete lock['slab[type=top]'];
    expect(refusals(lock, FIXTURE_DEFS)).toEqual([
      'slab[type=top] (id 21) is a new state of the locked type slab: a locked type never gains properties or values (append a new type; withType converts)',
    ]);
  });

  test('a changed id written into the lock file is refused, never rewritten', () => {
    const lock = { ...FIXTURE_LOCK, air: 60, 'door[facing=west,half=top,open=true,hinge=right]': 0 };
    expect(refusals(lock, FIXTURE_DEFS)).toEqual([
      'air is id 0, locked as 60: locked ids never change (append new types at the end)',
      'door[facing=west,half=top,open=true,hinge=right] is id 60, locked as 0: locked ids never change (append new types at the end)',
    ]);
  });

  test('a type named like an Object.prototype member is compared as a key', () => {
    const defs: BlockDef[] = [{ name: 'air', ...AIR_TABLES }, { name: 'constructor', ...SOLID_TABLES }];
    const reg = buildRegistry(defs);
    expect(stateLockViolations({ air: 0 }, reg)).toEqual(['states not yet in the lock (constructor): run npm run test:accept-state-ids']);
    const r = acceptStateIds({ air: 0 }, reg);
    expect(r.ok && r.next).toEqual({ air: 0, constructor: 1 });
  });
});

describe('the real lock against a changed copy of the real definitions', () => {
  test('swapping stone and bedrock is refused', () => {
    const lock = readStateLock();
    expect(lock).not.toBeNull();
    expect(refusals(lock, [BLOCK_DEFS[0]!, BLOCK_DEFS[2]!, BLOCK_DEFS[1]!])).toEqual([
      'stone is id 2, locked as 1: locked ids never change (append new types at the end)',
      'bedrock is id 1, locked as 2: locked ids never change (append new types at the end)',
    ]);
  });
});
