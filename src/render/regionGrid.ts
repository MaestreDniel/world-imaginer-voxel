import type { ColumnMeshPayload } from '../mesh/column';

/**
 * The region grid both section renderers share (SP4a spec §6.2, master §4.5): a region is 8 × 8 columns aligned to
 * `cx >> 3`, `cz >> 3`. `createRegionStaging` holds the expected columns and the staged payloads per region and hands
 * out the regions whose expected columns are all staged, nearest first; RegionBatch and RegionMesh only build.
 */

/** The region of column (cx, cz): `[cx >> 3, cz >> 3]`. */
export function regionOf(cx: number, cz: number): [number, number] {
  return [cx >> 3, cz >> 3];
}

/** The section origin in blocks: `(cx·16, sy·16 − 64, cz·16)` (spec §6.2). */
export function sectionOrigin(cx: number, cz: number, sy: number): [number, number, number] {
  return [cx * 16, sy * 16 - 64, cz * 16];
}

/** The region origin in blocks: `(rx·128, −64, rz·128)`. */
export function regionOrigin(rx: number, rz: number): [number, number, number] {
  return [rx * 128, -64, rz * 128];
}

/** A region whose expected columns are all staged, with their payloads in staging order. */
export interface StagedRegion {
  readonly rx: number;
  readonly rz: number;
  readonly payloads: readonly ColumnMeshPayload[];
}

export interface RegionStaging {
  /** Adds columns to the expected set (repeats are ignored). Throws for a column of a region already built. */
  expect(columns: ReadonlyArray<readonly [number, number]>): void;
  /** Stages a column's payload. Throws for a column that is not expected, or one staged twice. */
  stage(p: ColumnMeshPayload): void;
  /**
   * Builds, nearest region first, every region whose expected columns are all staged: checks `exhausted()` before
   * each region, calls `build` and returns the sum of what `build` returned. A built region drops its payloads.
   */
  buildReady(exhausted: () => boolean, build: (r: StagedRegion) => number): number;
  readonly expectedColumns: number;
  readonly stagedColumns: number;
  readonly regions: number;
  readonly builtRegions: number;
  /** Forgets every region and payload. */
  clear(): void;
}

interface RegionState {
  readonly rx: number;
  readonly rz: number;
  /** Expected column key → its payload, null until staged. */
  readonly columns: Map<number, ColumnMeshPayload | null>;
  staged: number;
  built: boolean;
}

/**
 * A column key for |cx|, |cz| < 2^20 (the world is ±31,250 columns): exact in a double. `regionKey` is the same for
 * region coordinates.
 */
const columnKey = (cx: number, cz: number): number => (cx + 1_048_576) * 2_097_152 + (cz + 1_048_576);

/**
 * (plan) "Nearest" is measured from the centroid of the expected columns to the region's centre, in columns; for the
 * page's mesh disc the centroid is the load centre. Ties go to the smaller rz, then the smaller rx.
 */
export function createRegionStaging(): RegionStaging {
  const regions = new Map<number, RegionState>();
  let expected = 0;
  let staged = 0;
  let built = 0;
  let sumX = 0;
  let sumZ = 0;

  const regionAt = (cx: number, cz: number): RegionState | undefined => {
    const [rx, rz] = regionOf(cx, cz);
    return regions.get(columnKey(rx, rz));
  };

  return {
    expect(columns) {
      for (const [cx, cz] of columns) {
        const [rx, rz] = regionOf(cx, cz);
        const rk = columnKey(rx, rz);
        let r = regions.get(rk);
        if (r === undefined) {
          r = { rx, rz, columns: new Map(), staged: 0, built: false };
          regions.set(rk, r);
        }
        const ck = columnKey(cx, cz);
        if (r.columns.has(ck)) continue;
        if (r.built) throw new Error(`column (${cx}, ${cz}) is in region (${rx}, ${rz}), which is already built`);
        r.columns.set(ck, null);
        expected++;
        sumX += cx;
        sumZ += cz;
      }
    },
    stage(p) {
      const r = regionAt(p.cx, p.cz);
      const ck = columnKey(p.cx, p.cz);
      if (r === undefined || !r.columns.has(ck)) throw new Error(`column (${p.cx}, ${p.cz}) is not expected`);
      if (r.built || r.columns.get(ck) !== null) throw new Error(`column (${p.cx}, ${p.cz}) is already staged`);
      r.columns.set(ck, p);
      r.staged++;
      staged++;
    },
    buildReady(exhausted, build) {
      const ready: RegionState[] = [];
      for (const r of regions.values()) if (!r.built && r.staged === r.columns.size) ready.push(r);
      if (ready.length === 0) return 0;
      const mx = expected > 0 ? sumX / expected : 0;
      const mz = expected > 0 ? sumZ / expected : 0;
      const d2 = (r: RegionState): number => (r.rx * 8 + 4 - mx) ** 2 + (r.rz * 8 + 4 - mz) ** 2;
      ready.sort((a, b) => d2(a) - d2(b) || a.rz - b.rz || a.rx - b.rx);
      let added = 0;
      for (const r of ready) {
        if (exhausted()) break;
        const payloads = [...r.columns.values()] as ColumnMeshPayload[];
        added += build({ rx: r.rx, rz: r.rz, payloads });
        r.built = true;
        built++;
        // The payloads are on the GPU side now; keep the keys (counts, refusals) and drop the buffers.
        for (const k of r.columns.keys()) r.columns.set(k, null);
      }
      return added;
    },
    get expectedColumns() {
      return expected;
    },
    get stagedColumns() {
      return staged;
    },
    get regions() {
      return regions.size;
    },
    get builtRegions() {
      return built;
    },
    clear() {
      regions.clear();
      expected = staged = built = sumX = sumZ = 0;
    },
  };
}
