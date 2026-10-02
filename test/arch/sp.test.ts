import { describe, expect, test } from 'vitest';
import { CURRENT_SP, SUB_PROJECTS } from '../../src/core/ids';
import { SP_DEPS, SP_ORDER, STARTED_SPS, spIndex, validateStarted } from '../harness/sp';

describe('started sub-projects', () => {
  test('the committed list is valid', () => {
    expect(validateStarted(STARTED_SPS)).toEqual([]);
  });

  test('the current SP has started', () => {
    expect(STARTED_SPS).toContain(CURRENT_SP);
  });

  test('SP_DEPS covers all 16 sub-projects and SP_ORDER follows it', () => {
    expect(SP_ORDER).toEqual([
      'SP0', 'SP1', 'SP2a', 'SP2b', 'SP3', 'SP4', 'SP5', 'SP6', 'SP7',
      'SP8a', 'SP8b', 'SP8c', 'SP9', 'SP10', 'SP11', 'SP12',
    ]);
    for (const sp of SP_ORDER) for (const dep of SP_DEPS[sp]) expect(spIndex(dep)).toBeLessThan(spIndex(sp));
    expect(SP_ORDER).toEqual([...SUB_PROJECTS]);
    expect([SP_DEPS.SP2a, SP_DEPS.SP2b, SP_DEPS.SP3]).toEqual([['SP1'], ['SP2a'], ['SP2b']]);
  });

  test('duplicates and unknown ids are rejected', () => {
    expect(validateStarted(['SP0', 'SP0'])).toEqual(['duplicate SP0']);
    expect(validateStarted(['SP0', 'SP99'])).toEqual(['unknown SP99']);
  });

  test('an SP cannot start before its dependencies', () => {
    expect(validateStarted(['SP0', 'SP2a'])).toEqual(['SP2a started before its dependency SP1']);
    expect(validateStarted(['SP0', 'SP1', 'SP2b'])).toEqual(['SP2b started before its dependency SP2a']);
  });

  test('parallel SPs: SP8c before SP8b is fine once SP7 and SP5 have started', () => {
    const path = ['SP0', 'SP1', 'SP2a', 'SP2b', 'SP3', 'SP4', 'SP8a', 'SP5', 'SP6', 'SP7', 'SP8c', 'SP8b'];
    expect(validateStarted(path)).toEqual([]);
  });

  test('parallel SPs: SP8c without SP7 is rejected', () => {
    const path = ['SP0', 'SP1', 'SP2a', 'SP2b', 'SP3', 'SP4', 'SP5', 'SP8c'];
    expect(validateStarted(path)).toEqual(['SP8c started before its dependency SP7']);
  });
});
