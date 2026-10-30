import { describe, expect, test } from 'vitest';
import { parseWorldQuery } from '../../src/ui/world/query';

const parse = (search: string) => parseWorldQuery(new URLSearchParams(search));

describe('parseWorldQuery (SP4a spec §8.1; rulings P42, P48)', () => {
  test('?at=12,-40&y=90&yaw=45&pitch=-20&rd=8&workers=4&renderer=mesh parses fully', () => {
    expect(parse('?at=12,-40&y=90&yaw=45&pitch=-20&rd=8&workers=4&renderer=mesh')).toEqual({
      at: { x: 12, z: -40 }, y: 90, yaw: 45, pitch: -20, rd: 8, workers: 4, renderer: 'mesh', shot: false, time: null, world: null, enterBench: false, db: null,
    });
  });

  test('an empty query is all null, shot false', () => {
    expect(parse('')).toEqual({ at: null, y: null, yaw: null, pitch: null, rd: null, workers: null, renderer: null, shot: false, time: null, world: null, enterBench: false, db: null });
  });

  test('?at=900000,0 clamps x to 500,000; ?rd=30 → 16; ?workers=1 → 2', () => {
    expect(parse('?at=900000,0').at).toEqual({ x: 500000, z: 0 });
    expect(parse('?at=0,-900000').at).toEqual({ x: 0, z: -500000 });
    expect(parse('?rd=30').rd).toBe(16);
    expect(parse('?rd=1').rd).toBe(4);
    expect(parse('?workers=1').workers).toBe(2);
    expect(parse('?workers=64').workers).toBe(6);
  });

  test('?at=abc → null; ?y=999 → 400', () => {
    expect(parse('?at=abc').at).toBeNull();
    expect(parse('?y=999').y).toBe(400);
    expect(parse('?y=-999').y).toBe(-64);
  });

  test('a malformed value is null', () => {
    expect(parse('?at=1').at).toBeNull();
    expect(parse('?at=1,2,3').at).toBeNull();
    expect(parse('?at=1.5,2').at).toBeNull();
    expect(parse('?at=').at).toBeNull();
    expect(parse('?y=').y).toBeNull();
    expect(parse('?y=high').y).toBeNull();
    expect(parse('?yaw=Infinity').yaw).toBeNull();
    expect(parse('?pitch=NaN').pitch).toBeNull();
    expect(parse('?rd=8.5').rd).toBeNull();
    expect(parse('?rd=').rd).toBeNull();
    expect(parse('?workers=four').workers).toBeNull();
    expect(parse('?renderer=webgpu').renderer).toBeNull();
  });

  test('degrees are copied unchanged (ruling P42)', () => {
    const q = parse('?yaw=315.5&pitch=-10.0');
    expect([q.yaw, q.pitch]).toEqual([315.5, -10]);
  });

  test('?shot=1&time=17.5 gives true and 17.5; ?time=25 and ?time=abc give null (ruling P48)', () => {
    const q = parse('?shot=1&time=17.5');
    expect([q.shot, q.time]).toEqual([true, 17.5]);
    expect(parse('?shot=true').shot).toBe(false);
    expect(parse('?time=25').time).toBeNull();
    expect(parse('?time=24').time).toBeNull();
    expect(parse('?time=-1').time).toBeNull();
    expect(parse('?time=abc').time).toBeNull();
    expect(parse('?time=0').time).toBe(0);
  });

  test('?world=abc → `world` \'abc\'; absent → null (SP5b spec §3.4, D4)', () => {
    expect(parse('?world=abc').world).toBe('abc');
    expect(parse('').world).toBeNull();
    expect(parse('?at=1,2').world).toBeNull();
  });

  test('`db` without `enterBench=1` is ignored (SP5b spec §6.2: the enter route\'s database)', () => {
    expect(parse('?world=w&db=wi10-bench')).toMatchObject({ world: 'w', enterBench: false, db: null });
    expect(parse('?world=w&enterBench=true&db=wi10-bench')).toMatchObject({ enterBench: false, db: null });
    expect(parse('?world=w&enterBench=1&db=wi10-bench')).toMatchObject({ world: 'w', enterBench: true, db: 'wi10-bench' });
    expect(parse('?at=1,2&enterBench=1')).toMatchObject({ enterBench: true, db: null });
    expect(parse('?enterBench=1&db=').db).toBeNull();
  });
});
