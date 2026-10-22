import { describe, expect, test } from 'vitest';
import { sp3eWindow } from '../../src/metrics/sp3eGoldens';
import { parseManifest } from '../../src/ui/loading/panoramas';
import { PANORAMAS as ROUTE_PANORAMAS } from '../../src/ui/world/panoramaRoute';
import { REVIEW_SITES } from '../harness/reviewSlices';
import { MAX_BYTES, manifestEntry, PANORAMAS, panoFile, parsePanoArgs, qualitySteps } from '../tools/panoramas';

/** Ruling P54: a review site's block coordinates, x = 16·cx0 + 8·w (the middle of its columns) and its z. */
function reviewSite(name: string): { x: number; z: number } {
  const s = REVIEW_SITES.find((r) => r.name === name);
  if (s === undefined || s.kind !== 'vertical') throw new Error(`no vertical review site ${name}`);
  return { x: 16 * s.cx0 + 8 * s.w, z: s.z };
}

/** Ruling P54: a preset's golden window centre, already in blocks. */
function presetSite(preset: 'archipelago' | 'amplified' | 'floating_islands'): { x: number; z: number } {
  const w = sp3eWindow(preset);
  return { x: w.centreX, z: w.centreZ };
}

describe('the panorama table (SP4a spec §8.3, D22; ruling P54)', () => {
  test('six unique ids', () => {
    expect(PANORAMAS).toHaveLength(6);
    expect(new Set(PANORAMAS.map((p) => p.id)).size).toBe(6);
  });

  test('every entry\'s site equals its source: three seed-42 default review sites, three preset golden windows', () => {
    const expected: Record<string, { seed: string; profile: string; x: number; z: number }> = {
      coast: { seed: '42', profile: 'default', ...reviewSite('coast') },
      mountain: { seed: '42', profile: 'default', ...reviewSite('mountain') },
      badlands: { seed: '42', profile: 'default', ...reviewSite('badlands') },
      archipelago: { seed: '42', profile: 'archipelago', ...presetSite('archipelago') },
      amplified: { seed: '42', profile: 'amplified', ...presetSite('amplified') },
      floating_islands: { seed: '42', profile: 'floating_islands', ...presetSite('floating_islands') },
    };
    expect(PANORAMAS.map((p) => p.id).sort()).toEqual(Object.keys(expected).sort());
    for (const p of PANORAMAS) expect({ seed: p.seed, profile: p.profile, x: p.x, z: p.z }).toEqual(expected[p.id]);
    // The ruling's worked values, so a change of a source is seen here too.
    expect(reviewSite('coast')).toEqual({ x: -26624, z: -31992 });
    expect(presetSite('floating_islands')).toEqual({ x: -768, z: -1408 });
  });

  test('every entry is at 08:00 or 17:00 with a yaw in [0, 360)', () => {
    for (const p of PANORAMAS) {
      expect([8, 17]).toContain(p.time);
      expect(p.yawDeg).toBeGreaterThanOrEqual(0);
      expect(p.yawDeg).toBeLessThan(360);
    }
  });

  test('the tool\'s table equals panoramaRoute.ts\' table', () => {
    expect(ROUTE_PANORAMAS).toEqual(PANORAMAS);
  });
});

describe('the panorama tool\'s pure parts (SP4a spec §8.3)', () => {
  test('panoFile(\'coast\') is coast.webp', () => {
    expect(panoFile('coast')).toBe('coast.webp');
  });

  test('parsePanoArgs([\'--gpu\']) gives gpu true; the defaults; an unknown flag throws', () => {
    expect(parsePanoArgs(['--gpu'])).toEqual({ gpu: true, skipBuild: false });
    expect(parsePanoArgs([])).toEqual({ gpu: false, skipBuild: false });
    expect(parsePanoArgs(['--skip-build'])).toEqual({ gpu: false, skipBuild: true });
    expect(() => parsePanoArgs(['--what'])).toThrow(/unknown argument --what/);
  });

  test('MAX_BYTES is 400 KiB; the qualities start at 80 and step down by 5', () => {
    expect(MAX_BYTES).toBe(400 * 1024);
    const q = qualitySteps();
    expect(q[0]).toBe(80);
    expect(q.at(-1)).toBe(5);
    for (let i = 1; i < q.length; i++) expect(q[i - 1]! - q[i]!).toBe(5);
  });

  test('a manifest entry passes the loading screen\'s parseManifest unchanged', () => {
    const entries = PANORAMAS.map((p) => manifestEntry(p, 'abc1234', 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device))'));
    expect(parseManifest(JSON.parse(JSON.stringify(entries)))).toEqual(entries);
    expect(entries[0]).toMatchObject({ file: `${PANORAMAS[0]!.id}.webp`, yaw: PANORAMAS[0]!.yawDeg, pitch: -10, commit: 'abc1234' });
  });
});
