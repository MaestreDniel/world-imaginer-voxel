import { describe, expect, test } from 'vitest';
import { CURRENT_SP, SUB_PROJECTS } from '../../src/core/ids';
import { currentSpOf, SP_DEPS, SP_ORDER, STARTED_SPS, spIndex, validateStarted } from '../harness/sp';

describe('started sub-projects', () => {
  test('the committed list is valid', () => {
    expect(validateStarted(STARTED_SPS)).toEqual([]);
  });

  test('the current SP has started', () => {
    expect(STARTED_SPS).toContain(CURRENT_SP);
  });

  test('CURRENT_SP follows the SP3a §9 rule: the last SP of the longest fully started prefix', () => {
    expect(CURRENT_SP).toBe(currentSpOf(STARTED_SPS));
  });

  test('SP3b has started and is the current SP (SP3b spec §12)', () => {
    expect(STARTED_SPS).toEqual(['SP0', 'SP1', 'SP2a', 'SP2b', 'SP3a', 'SP3b']);
    expect(CURRENT_SP).toBe('SP3b');
  });

  test('currentSpOf stops at the first unstarted SP (SP4 alongside SP3c and SP3d)', () => {
    const upTo3b = ['SP0', 'SP1', 'SP2a', 'SP2b', 'SP3a', 'SP3b'] as const;
    expect(currentSpOf([])).toBeNull();
    expect(currentSpOf(['SP0', 'SP1'])).toBe('SP1');
    expect(currentSpOf([...upTo3b, 'SP4'])).toBe('SP3b');
    expect(currentSpOf([...upTo3b, 'SP4', 'SP3c'])).toBe('SP3c');
    expect(currentSpOf([...upTo3b, 'SP4', 'SP3c', 'SP3d'])).toBe('SP4');
  });

  test('SP_DEPS covers all 19 sub-projects and SP_ORDER follows it', () => {
    expect(SP_ORDER).toEqual([
      'SP0', 'SP1', 'SP2a', 'SP2b', 'SP3a', 'SP3b', 'SP3c', 'SP3d', 'SP4', 'SP5', 'SP6', 'SP7',
      'SP8a', 'SP8b', 'SP8c', 'SP9', 'SP10', 'SP11', 'SP12',
    ]);
    for (const sp of SP_ORDER) for (const dep of SP_DEPS[sp]) expect(spIndex(dep)).toBeLessThan(spIndex(sp));
    expect(SP_ORDER).toEqual([...SUB_PROJECTS]);
    expect([SP_DEPS.SP2a, SP_DEPS.SP2b]).toEqual([['SP1'], ['SP2a']]);
    expect([SP_DEPS.SP3a, SP_DEPS.SP3b, SP_DEPS.SP3c, SP_DEPS.SP3d, SP_DEPS.SP4, SP_DEPS.SP6]).toEqual([
      ['SP2b'], ['SP3a'], ['SP3b'], ['SP3c'], ['SP3b'], ['SP3c', 'SP5'],
    ]);
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
    const path = ['SP0', 'SP1', 'SP2a', 'SP2b', 'SP3a', 'SP3b', 'SP4', 'SP3c', 'SP8a', 'SP5', 'SP6', 'SP7', 'SP8c', 'SP8b'];
    expect(validateStarted(path)).toEqual([]);
  });

  test('parallel SPs: SP8c without SP7 is rejected', () => {
    const path = ['SP0', 'SP1', 'SP2a', 'SP2b', 'SP3a', 'SP3b', 'SP4', 'SP5', 'SP8c'];
    expect(validateStarted(path)).toEqual(['SP8c started before its dependency SP7']);
  });

  test('parallel SPs: SP3c and SP3d may start after SP4; SP4 and SP3c need SP3b, SP3d needs SP3c', () => {
    const upTo3a = ['SP0', 'SP1', 'SP2a', 'SP2b', 'SP3a'];
    expect(validateStarted([...upTo3a, 'SP3b', 'SP4', 'SP3c', 'SP3d'])).toEqual([]);
    expect(validateStarted([...upTo3a, 'SP4'])).toEqual(['SP4 started before its dependency SP3b']);
    expect(validateStarted([...upTo3a, 'SP3c'])).toEqual(['SP3c started before its dependency SP3b']);
    expect(validateStarted([...upTo3a, 'SP3b', 'SP3d'])).toEqual(['SP3d started before its dependency SP3c']);
  });

  test('SP6 needs SP3c (surface rules) and SP5, not SP3d', () => {
    const upTo3b = ['SP0', 'SP1', 'SP2a', 'SP2b', 'SP3a', 'SP3b'];
    expect(validateStarted([...upTo3b, 'SP4', 'SP5', 'SP6'])).toEqual(['SP6 started before its dependency SP3c']);
    expect(validateStarted([...upTo3b, 'SP4', 'SP5', 'SP3c', 'SP6'])).toEqual([]);
  });
});
