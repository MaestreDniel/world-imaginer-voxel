/**
 * The fresh-light check E5's two parts share (SP5a spec §6.1, `edit.metric.ts`'s L3 and E5's session part; SP5b spec
 * §6.1, `persist.metric.ts`'s `flushLightMismatches`): every column of the 3 × 3 around each edited column against a
 * fresh `copyLightRegion` and `lightRegion` of it (`mayEmit` true), voxel by voxel, inside a read section.
 */
import { colKey, colKeyCx, colKeyCz } from '../../src/core/coords';
import { centreSection, createLightScratch, DEFAULT_LIGHT_TABLES, lightRegion } from '../../src/light/initial';
import { SECTIONS } from '../../src/world/store/columnTable';
import { copyLightRegion } from '../../src/world/store/padded';
import type { VoxelStore } from '../../src/world/store/store';

const scratch = createLightScratch();
const bytesOf = (a: Uint8Array): Buffer => Buffer.from(a.buffer, a.byteOffset, a.byteLength);
const uniform = (a: Uint8Array, v: number): boolean => {
  for (let i = 0; i < a.length; i++) if (a[i] !== v) return false;
  return true;
};

/**
 * Compares every column of the 3 × 3 around each of `cols` (colKeys) with a fresh `lightRegion` of it: the number of
 * voxels whose stored light differs (a column with no final set counts its 4096 × 24), each described to `report`.
 */
export function freshLightMismatches(store: VoxelStore, cols: Iterable<number>, report: (problem: string) => void, what: string): number {
  const seen = new Set<number>();
  let n = 0;
  store.enterRead();
  try {
    for (const k of cols) {
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const cx = colKeyCx(k) + dx;
          const cz = colKeyCz(k) + dz;
          const key = colKey(cx, cz);
          if (seen.has(key)) continue;
          seen.add(key);
          const f = store.final(cx, cz);
          if (f === null) {
            n += 4096 * SECTIONS;
            report(`${what}: column (${cx}, ${cz}) has no final set`);
            continue;
          }
          copyLightRegion(store.neighborhood(cx, cz), scratch.region);
          lightRegion(scratch, DEFAULT_LIGHT_TABLES, true);
          for (let sy = 0; sy < SECTIONS; sy++) {
            const want = centreSection(scratch, sy);
            const stored = f.sectionLight(sy);
            if (typeof stored === 'number' ? uniform(want, stored) : bytesOf(stored).equals(bytesOf(want))) continue;
            for (let i = 0; i < 4096; i++) {
              const got = typeof stored === 'number' ? stored : stored[i]!;
              if (got === want[i]) continue;
              n++;
              const x = 16 * cx + (i & 15);
              const z = 16 * cz + ((i >> 4) & 15);
              const y = 16 * sy - 64 + (i >> 8);
              report(`${what}: (${x}, ${y}, ${z}) light ${got >> 4}/${got & 15} ≠ lightRegion ${want[i]! >> 4}/${want[i]! & 15} (sky/block)`);
            }
          }
        }
      }
    }
  } finally {
    store.exitRead();
  }
  return n;
}
