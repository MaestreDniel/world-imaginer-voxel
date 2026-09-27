import { describe, expect, test } from 'vitest';
import { SP_DEPS, SP_ORDER, STARTED_SPS, spIndex, validateStarted } from '../harness/sp';

describe('started sub-projects', () => {
  test('the committed list is valid', () => {
    expect(validateStarted(STARTED_SPS)).toEqual([]);
  });

  test('SP_DEPS covers all 15 sub-projects and SP_ORDER follows it', () => {
    expect(SP_ORDER).toEqual([
      'SP0', 'SP1', 'SP2', 'SP3', 'SP4', 'SP5', 'SP6', 'SP7',
      'SP8a', 'SP8b', 'SP8c', 'SP9', 'SP10', 'SP11', 'SP12',
    ]);
    for (const sp of SP_ORDER) for (const dep of SP_DEPS[sp]) expect(spIndex(dep)).toBeLessThan(spIndex(sp));
  });

  test('duplicates and unknown ids are rejected', () => {
    expect(validateStarted(['SP0', 'SP0'])).toEqual(['duplicate SP0']);
    expect(validateStarted(['SP0', 'SP99'])).toEqual(['unknown SP99']);
  });

  test('an SP cannot start before its dependencies', () => {
    expect(validateStarted(['SP0', 'SP2'])).toEqual(['SP2 started before its dependency SP1']);
  });

  test('parallel SPs: SP8c before SP8b is fine once SP7 and SP5 have started', () => {
    const path = ['SP0', 'SP1', 'SP2', 'SP3', 'SP4', 'SP8a', 'SP5', 'SP6', 'SP7', 'SP8c', 'SP8b'];
    expect(validateStarted(path)).toEqual([]);
  });

  test('parallel SPs: SP8c without SP7 is rejected', () => {
    const path = ['SP0', 'SP1', 'SP2', 'SP3', 'SP4', 'SP5', 'SP8c'];
    expect(validateStarted(path)).toEqual(['SP8c started before its dependency SP7']);
  });
});
