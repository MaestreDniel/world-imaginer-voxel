import { describe, expect, test } from 'vitest';
import { hex64 } from '../../src/core/hash';
import type { StageId } from '../../src/core/ids';
import { DEFAULTS } from '../../src/core/params/defaults';
import { applyPatch } from '../../src/core/params/kit';
import { SCHEMA } from '../../src/core/params/schema';
import { stageHashes } from '../../src/core/stage/hash';
import { STAGES } from '../../src/core/stage/registry';
import { appliedDraftOf, regenFrom, type AppliedDraft } from '../../src/engine/invalidation';

const IDS: readonly StageId[] = STAGES.map((s) => s.id);
const SEED = '42.0';

/** Synthetic hex hashes over every stage id; `changed` gets a different hex, `missing` none. */
function hexes(changed: readonly StageId[] = [], missing: readonly StageId[] = []): Partial<Record<StageId, string>> {
  const out: Partial<Record<StageId, string>> = {};
  IDS.forEach((id, i) => {
    if (missing.includes(id)) return;
    out[id] = (changed.includes(id) ? 0xf0000000 + i : 0x10000000 + i).toString(16).padStart(16, '0');
  });
  return out;
}

const draft = (hashes: Partial<Record<StageId, string>>, seedKey = SEED, genKey = 'abcdef0123456789'): AppliedDraft =>
  ({ seedKey, hashes, genKey });

/** The real stage hashes of `params`, hexed as the workers send them (`taskHandler.ts`'s ready reply). */
function realHex(params: unknown): Partial<Record<StageId, string>> {
  const h = stageHashes(params);
  const out: Partial<Record<StageId, string>> = {};
  for (const id of IDS) {
    const v = h[id];
    if (v !== undefined) out[id] = hex64(v);
  }
  return out;
}

function patched(patch: unknown): unknown {
  const r = applyPatch(SCHEMA, DEFAULTS, patch);
  if (!r.ok) throw new Error(`bad patch: ${JSON.stringify(r.issues)}`);
  return r.value;
}

describe('regenFrom on synthetic hex hashes (SP4c spec §4.1)', () => {
  test('equal drafts → null', () => {
    expect(regenFrom(draft(hexes()), draft(hexes()))).toBeNull();
  });

  test('a seed change with equal hashes → T', () => {
    expect(regenFrom(draft(hexes(), '42.0'), draft(hexes(), '43.0'))).toBe('T');
  });

  test.each(['climate', 'shape', 'surfaceEst', 'biome2d', 'terrain'] as const)('%s alone differing → T', (id) => {
    expect(regenFrom(draft(hexes()), draft(hexes([id])))).toBe('T');
  });

  test('decorate alone → D, light alone → L, mesh alone → MESH', () => {
    expect(regenFrom(draft(hexes()), draft(hexes(['decorate'])))).toBe('D');
    expect(regenFrom(draft(hexes()), draft(hexes(['light'])))).toBe('L');
    expect(regenFrom(draft(hexes()), draft(hexes(['mesh'])))).toBe('MESH');
  });

  test('lod alone and map alone → null', () => {
    expect(regenFrom(draft(hexes()), draft(hexes(['lod'])))).toBeNull();
    expect(regenFrom(draft(hexes()), draft(hexes(['map'])))).toBeNull();
    expect(regenFrom(draft(hexes()), draft(hexes(['lod', 'map'])))).toBeNull();
  });

  test('climate and mesh differing → T (the earliest wins)', () => {
    expect(regenFrom(draft(hexes()), draft(hexes(['climate', 'mesh'])))).toBe('T');
    expect(regenFrom(draft(hexes()), draft(hexes(['light', 'mesh'])))).toBe('L');
  });

  test('a stage missing on one side counts as dirty', () => {
    expect(regenFrom(draft(hexes([], ['decorate'])), draft(hexes()))).toBe('D');
    expect(regenFrom(draft(hexes()), draft(hexes([], ['shape'])))).toBe('T');
    expect(regenFrom(draft(hexes()), draft(hexes([], ['mesh'])))).toBe('MESH');
    expect(regenFrom(draft(hexes([], ['map'])), draft(hexes()))).toBeNull();
  });

  test('the genKey alone does not decide (the seed and the stage hashes do)', () => {
    expect(regenFrom(draft(hexes(), SEED, '0000000000000001'), draft(hexes(), SEED, '0000000000000002'))).toBeNull();
  });
});

describe('regenFrom on the real stage hashes, hexed', () => {
  const base = appliedDraftOf(SEED, { stageHashes: realHex(DEFAULTS), genKey: 'g0' });

  test('the default params against density.detailAmpHi 4.0 → T', () => {
    const next = appliedDraftOf(SEED, { stageHashes: realHex(patched({ density: { detailAmpHi: 4.0 } })), genKey: 'g1' });
    expect(regenFrom(base, next)).toBe('T');
  });

  test("the default params against climate.C's wavelength 1200 → T", () => {
    const next = appliedDraftOf(SEED, { stageHashes: realHex(patched({ climate: { C: { wavelength: 1200 } } })), genKey: 'g1' });
    expect(regenFrom(base, next)).toBe('T');
  });

  test('the default params twice → null', () => {
    expect(regenFrom(base, appliedDraftOf(SEED, { stageHashes: realHex(DEFAULTS), genKey: 'g0' }))).toBeNull();
  });
});

describe('appliedDraftOf', () => {
  test('carries the seed key, the hex stage hashes and the genKey', () => {
    const stageHashes = hexes();
    const d = appliedDraftOf('7.9', { stageHashes, genKey: '0123456789abcdef' });
    expect(d).toEqual({ seedKey: '7.9', hashes: stageHashes, genKey: '0123456789abcdef' });
  });
});
