import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { buildColumnSample, newColumnSample, readLevel } from '../../src/gen/column/columnStage';
import { fluidType } from '../../src/world/blocks/fluid';
import { BEDROCK } from '../../src/world/blocks/index';
import { ctxFor, paramsWith } from '../harness/gen';
import { encodePng, VOXEL_COLORS } from '../harness/png';
import type { RegionView } from '../harness/region';
import {
  generateSite, lineKinds, positionKind, renderSite, REVIEW_KINDS, REVIEW_SITES, upscale, writeReviewSlices,
  type ReviewKind, type VerticalSite,
} from '../harness/reviewSlices';

const ctx = ctxFor('42');
const params = paramsWith();
const verticals = REVIEW_SITES.filter((s): s is VerticalSite => s.kind === 'vertical');

/** True when column (x, z) of the view holds a water voxel. */
function wetAt(view: RegionView, x: number, z: number): boolean {
  for (let y = -64; y <= 319; y++) if (fluidType(view.fluid(x, y, z)) !== 0) return true;
  return false;
}

describe('review sites (spec §12 visual review)', () => {
  test('the sites: a coast, a lake and a river vertical slice, and a horizontal slice at y 62', () => {
    expect(REVIEW_SITES.map((s) => s.name)).toEqual(['coast', 'lake', 'river', 'y62']);
    expect(new Set(REVIEW_SITES.map((s) => s.file)).size).toBe(REVIEW_SITES.length);
    const y62 = REVIEW_SITES.find((s) => s.name === 'y62')!;
    expect(y62.kind === 'horizontal' && y62.y).toBe(62);
    for (const s of REVIEW_SITES) {
      expect(s.w, s.name).toBeGreaterThanOrEqual(1);
      expect(s.w, s.name).toBeLessThanOrEqual(64);
      if (s.kind === 'horizontal') {
        expect(s.h).toBeLessThanOrEqual(64);
        expect(s.checkZ >> 4).toBeGreaterThanOrEqual(s.cz0);
        expect(s.checkZ >> 4).toBeLessThan(s.cz0 + s.h);
      }
    }
  });

  test.each(REVIEW_SITES.map((s) => [s.name, s] as const))('%s: the line crosses every kind the site needs', (_name, site) => {
    const kinds = lineKinds(ctx, site);
    expect(Object.values(kinds).reduce((a, b) => a + b, 0)).toBe(16 * site.w);
    for (const k of site.needs) expect(kinds[k], `${site.name} needs ${k}: ${JSON.stringify(kinds)}`).toBeGreaterThan(0);
  });

  test('positionKind: every kind occurs on the sites; a position outside the sample column throws', () => {
    const seen = new Set<ReviewKind>();
    for (const s of verticals) for (const [k, n] of Object.entries(lineKinds(ctx, s))) if (n > 0) seen.add(k as ReviewKind);
    expect([...seen].sort()).toEqual([...REVIEW_KINDS].sort());
    const s = buildColumnSample(ctx, 3, -2, newColumnSample());
    expect(() => positionKind(s, 16 * 3 + 16, -32)).toThrow(RangeError);
    expect(() => positionKind(s, 16 * 3, -33)).toThrow(RangeError);
  });
});

describe('vertical review slices over the generated voxels', () => {
  test.each(verticals.map((s) => [s.name, s] as const))('%s: kinds agree with the voxels; the crop removes only air and stone', async (_name, site) => {
    const view = await generateSite('42', params, site);
    const s = newColumnSample();
    let cx = Number.NaN;
    let lakeAbove63 = 0;
    // On the real T (SP3b) σ, jag and detail move each position's top away from the 2D estimate, so the 2D kind no
    // longer predicts every position's water: a wet position needs a finite water level, and each needed kind must
    // show up wet (land: dry) somewhere on the line. Task 14 derives the kinds from the voxels.
    const seen = { land: 0, sea: 0, lake: 0, river: 0 };
    for (let x = 16 * site.cx0; x < 16 * (site.cx0 + site.w); x++) {
      if (x >> 4 !== cx) buildColumnSample(ctx, (cx = x >> 4), site.z >> 4, s);
      const kind = positionKind(s, x, site.z);
      const wet = wetAt(view, x, site.z);
      if (wet) expect(readLevel(s, 'surfaceWaterLevel', x, site.z), `(${x}, ${site.z}) is wet`).not.toBe(-Infinity);
      if (wet === (kind !== 'land')) seen[kind]++;
      const top = view.worldSurfaceWG(x, site.z) - 1;
      const floor = view.oceanFloorWG(x, site.z) - 1;
      expect(top, `(${x}, ${site.z}) top ${top} above the crop`).toBeLessThanOrEqual(site.yMax);
      expect(floor, `(${x}, ${site.z}) ground ${floor} below the crop`).toBeGreaterThanOrEqual(site.yMin);
      if (kind === 'lake' && fluidType(view.fluid(x, top, site.z)) !== 0 && top > 63) lakeAbove63++;
      expect(view.block(x, -64, site.z)).toBe(BEDROCK);
    }
    for (const k of site.needs) expect(seen[k], `${site.name}: ${k} on the voxels`).toBeGreaterThan(0);
    if (site.needs.includes('lake')) expect(lakeAbove63).toBeGreaterThan(0);
  });

  test('renderSite: the slice size, the bottom row of bedrock at y −64, the upscale', async () => {
    const coast = verticals.find((s) => s.name === 'coast')!;
    expect([coast.yMin, coast.scale]).toEqual([-64, 1]);
    const img = renderSite(await generateSite('42', params, coast), coast);
    expect([img.width, img.height]).toEqual([16 * coast.w, coast.yMax - coast.yMin + 1]);
    const last = 4 * img.width * (img.height - 1);
    for (let i = 0; i < img.width; i++) {
      expect([...img.rgba.subarray(last + 4 * i, last + 4 * i + 3)]).toEqual([...VOXEL_COLORS.bedrock]);
    }
    const river = verticals.find((s) => s.name === 'river')!;
    const view = await generateSite('42', params, river);
    const one = renderSite(view, { ...river, scale: 1 });
    const two = renderSite(view, river);
    expect(river.scale).toBe(2);
    expect([two.width, two.height]).toEqual([2 * one.width, 2 * one.height]);
    for (const [x, y] of [[0, 0], [17, 9], [one.width - 1, one.height - 1]] as const) {
      const p = [...one.rgba.subarray(4 * (y * one.width + x), 4 * (y * one.width + x) + 4)];
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const q = 4 * ((2 * y + dy) * two.width + 2 * x + dx);
        expect([...two.rgba.subarray(q, q + 4)]).toEqual(p);
      }
    }
    expect(() => upscale(one, 0)).toThrow(RangeError);
    expect(upscale(one, 1)).toBe(one);
  });

  test('writeReviewSlices writes each site as the PNG of its slice', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wi10-review-'));
    try {
      const site: VerticalSite = { ...verticals.find((s) => s.name === 'coast')!, w: 4, file: 'small.png' };
      const [written] = await writeReviewSlices(dir, '42', params, [site]);
      expect(written!.path).toBe(join(dir, 'small.png'));
      const bytes = readFileSync(written!.path);
      expect(new Uint8Array(bytes)).toEqual(new Uint8Array(encodePng(renderSite(await generateSite('42', params, site), site))));
      expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([64, 224]);
      expect([written!.width, written!.height, written!.bytes]).toEqual([64, 224, bytes.length]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * `npm run docs:review-slices` sets REVIEW_SLICES_DIR to `docs/superpowers/specs/assets/sp3a` and writes every site
 * there (the 64 × 64 horizontal slice takes a few seconds), plus `slices.json` (each site and the kinds its line
 * crosses); without it nothing is written.
 */
test.runIf(process.env.REVIEW_SLICES_DIR !== undefined)('write the review slices into REVIEW_SLICES_DIR', async () => {
  const written = await writeReviewSlices(process.env.REVIEW_SLICES_DIR!, '42', params);
  expect(written.map((w) => w.site.file)).toEqual(REVIEW_SITES.map((s) => s.file));
  const summary = written.map((w) => ({
    file: w.site.file, width: w.width, height: w.height, site: w.site, lineKinds: lineKinds(ctx, w.site),
  }));
  writeFileSync(join(process.env.REVIEW_SLICES_DIR!, 'slices.json'), `${JSON.stringify({ seed: '42', profile: 'default', slices: summary }, null, 2)}\n`);
}, 300_000);
