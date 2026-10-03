import { describe, expect, test } from 'vitest';
import { REGISTRY } from '../../src/world/blocks/index';
import { buildRegistry, type BlockRegistry } from '../../src/world/blocks/registry';
import { FIXTURE_BASE, FIXTURE_DEFS } from '../harness/blockFixtures';
import { registryRoundTripFailures } from '../harness/registryChecks';

/**
 * The M1 registry checks (SP3a spec §2.4, master §6.4 M1): every state survives four quarter turns, two mirrors per
 * axis, `stateOf(propsOf)`, `parseStateKey(stateKey)` and a `withProp` round trip through every value of every
 * property. A registry that breaks any of them is reported, state by state.
 */
const FIXTURE = buildRegistry(FIXTURE_DEFS);

/** `reg` with one method replaced: the M1 checks must see the broken behaviour. */
const broken = (reg: BlockRegistry, patch: Partial<BlockRegistry>): BlockRegistry => ({ ...reg, ...patch });

describe('registryRoundTripFailures', () => {
  test('the real registry and the fixture registry have none', () => {
    expect(registryRoundTripFailures(REGISTRY)).toEqual([]);
    expect(registryRoundTripFailures(FIXTURE)).toEqual([]);
  });

  test('a rotation that is not the identity after four quarter turns is reported', () => {
    const chestNorth = FIXTURE_BASE.chest;
    // One quarter turn of a north chest gives east, but the second turn sticks at east.
    const reg = broken(FIXTURE, {
      rotateState: (s, q) => (s === chestNorth + 1 && ((q % 4) + 4) % 4 === 1 ? s : FIXTURE.rotateState(s, q)),
    });
    const f = registryRoundTripFailures(reg);
    expect(f.some((m) => m.includes('chest[facing=north]') && m.includes('rotateState'))).toBe(true);
  });

  test('a mirror that is not an involution is reported', () => {
    const reg = broken(FIXTURE, { mirrorState: (s, a) => (a === 'z' && s === FIXTURE_BASE.door ? s + 1 : FIXTURE.mirrorState(s, a)) });
    const f = registryRoundTripFailures(reg);
    expect(f.some((m) => m.includes('mirrorState') && m.includes("'z'"))).toBe(true);
  });

  test('broken stateOf/propsOf, key and withProp round trips are reported', () => {
    const log = FIXTURE_BASE.log;
    const keys = registryRoundTripFailures(broken(FIXTURE, { parseStateKey: (k) => (k === 'log[axis=x]' ? log : FIXTURE.parseStateKey(k)) }));
    expect(keys).toEqual(['log[axis=x] (id 2): parseStateKey(stateKey) = 1']);
    const props = registryRoundTripFailures(broken(FIXTURE, { stateOf: (t, p) => (t === FIXTURE.typeId('slab') ? FIXTURE_BASE.slab : FIXTURE.stateOf(t, p)) }));
    expect(props.filter((m) => m.includes('stateOf(propsOf)'))).toHaveLength(2);
    const withProp = registryRoundTripFailures(broken(FIXTURE, {
      withProp: (s, p, v) => (p === 'hinge' && v === 'right' ? s : FIXTURE.withProp(s, p, v)),
    }));
    expect(withProp.length).toBeGreaterThan(0);
    expect(withProp.every((m) => m.includes('withProp') && m.includes('hinge'))).toBe(true);
  });

  test('a method that throws is a failure, not a crash', () => {
    const f = registryRoundTripFailures(broken(FIXTURE, {
      stateKey: (s) => {
        if (s === FIXTURE_BASE.gate) throw new Error('boom');
        return FIXTURE.stateKey(s);
      },
    }));
    expect(f).toEqual([`state ${FIXTURE_BASE.gate}: threw Error: boom`]);
  });

  test('a state count over MAX_STATES or a non-contiguous type is reported', () => {
    expect(registryRoundTripFailures(broken(FIXTURE, { stateCount: 4097 }))[0]).toMatch(/stateCount 4097/);
    const types = FIXTURE.STATE_TYPE.slice();
    types[FIXTURE_BASE.chest + 2] = FIXTURE.typeId('log');
    const f = registryRoundTripFailures(broken(FIXTURE, { STATE_TYPE: types }));
    expect(f.some((m) => m.includes('not contiguous'))).toBe(true);
  });
});
