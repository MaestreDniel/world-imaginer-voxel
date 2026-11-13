/**
 * The nibble fixture (SP6b spec §2.1, Task 8): T writes the cave biome into bits 4-7 of the `cave` byte at tagged voxels
 * (kind ≠ 0), so every reader that compares the stored byte with a kind must read it through `caveKindOf`. The fixture
 * gives every tagged byte the biome (x + z) & 3 (`nibbleOf`, world coordinates) in place of the one T wrote and leaves
 * the untagged bytes 0, as T's write does; its plain bytes are the kinds alone (T's biomes cleared, Task 17). A reader
 * that masks gives the same kind-level outputs on both.
 * - `withNibbles(view)`: a column view (`ColumnView`) or a region view (`RegionView`: its `tag` and its store's columns)
 *   reading the nibbled bytes; a uniform tagged section becomes dense (its voxels' biomes differ). `withKinds(view)`
 *   reads the plain bytes.
 * - `nibblingStore(store)`: the nibbled bytes written through the store, for a reader that generates its own columns;
 *   `kindsStore(store)` the plain ones.
 * - `nibbleRegion()`: the fixture region, the 5 × 5 chunks of seed '42' at (545, 25856) up to T, generated in process
 *   once: it holds the caverns' column (546, 25857) of `caveTags.test.ts` (a cheese cavern crossed by a worm), entrances
 *   and a ravine, with entrance and ravine pairs across its interior's chunk borders (`crossingPairs`).
 */
import type { GenContext } from '../../src/gen/context';
import { genRegionInProcess } from '../../src/metrics/region';
import type { ColumnView, ColumnWriter } from '../../src/world/store/api';
import { createStore, type VoxelStore } from '../../src/world/store/store';
import { ctxFor } from './gen';
import { regionView, type RegionView } from './regionView';

/** The fixture's high nibble at world position (x, z): the biome (x + z) & 3 in bits 4-7. */
export const nibbleOf = (x: number, z: number): number => ((x + z) & 3) << 4;

/** The nibble a rewrite puts on a tagged byte at world (x, z): the fixture's, or none (the plain bytes). */
type Nibble = (x: number, z: number) => number;
const NONE: Nibble = () => 0;

/** Section `sec` of column (cx, cz), y0 = −64 + 16·sy, every tagged byte its kind with `nib`'s high nibble. */
function nibbledSection(sec: Uint8Array | number, cx: number, cz: number, nib: Nibble = nibbleOf): Uint8Array | number {
  if (sec === 0) return 0;
  const out = new Uint8Array(4096);
  for (let i = 0; i < 4096; i++) {
    const b = typeof sec === 'number' ? sec : sec[i]!;
    out[i] = b === 0 ? 0 : (b & 15) | nib(16 * cx + (i & 15), 16 * cz + ((i >> 4) & 15));
  }
  return out;
}

function nibbledColumn(v: ColumnView, nib: Nibble = nibbleOf): ColumnView {
  const secs: Array<Uint8Array | number> = [];
  for (let sy = 0; sy < 24; sy++) secs.push(nibbledSection(v.sectionCave(sy), v.cx, v.cz, nib));
  return {
    cx: v.cx, cz: v.cz,
    block: (lx, y, lz) => v.block(lx, y, lz),
    fluid: (lx, y, lz) => v.fluid(lx, y, lz),
    light: (lx, y, lz) => v.light(lx, y, lz),
    sectionBlocks: (sy) => v.sectionBlocks(sy),
    sectionFluid: (sy) => v.sectionFluid(sy),
    sectionLight: (sy) => v.sectionLight(sy),
    sectionCave: (sy) => {
      if (!Number.isInteger(sy) || sy < 0 || sy >= 24) throw new RangeError(`withNibbles: section ${sy}`);
      return secs[sy]!;
    },
    cave: (lx, y, lz) => {
      v.cave(lx, y, lz); // the plain view's range checks
      const s = secs[(y + 64) >> 4]!;
      return typeof s === 'number' ? s : s[(((y + 64) & 15) << 8) | (lz << 4) | lx]!;
    },
    aux: () => v.aux(),
    auxB: () => v.auxB(),
  };
}

function nibbledRegion(view: RegionView, nib: Nibble = nibbleOf): RegionView {
  const cache = new Map<ColumnView, ColumnView>();
  const wrap = (v: ColumnView | null): ColumnView | null => {
    if (v === null) return null;
    let n = cache.get(v);
    if (n === undefined) cache.set(v, (n = nibbledColumn(v, nib)));
    return n;
  };
  const base = view.store;
  const finals = new Map<string, ColumnView | null>();
  const protos = new Map<string, ColumnView | null>();
  const memo = (m: Map<string, ColumnView | null>, read: () => ColumnView | null, cx: number, cz: number): ColumnView | null => {
    const k = `${cx},${cz}`;
    if (!m.has(k)) m.set(k, wrap(read()));
    return m.get(k)!;
  };
  const store: VoxelStore = Object.assign(Object.create(base) as VoxelStore, {
    final: (cx: number, cz: number) => memo(finals, () => base.final(cx, cz), cx, cz),
    proto: (cx: number, cz: number) => memo(protos, () => base.proto(cx, cz), cx, cz),
  });
  const col = (x: number, z: number): ColumnView => {
    const v = store.final(x >> 4, z >> 4) ?? store.proto(x >> 4, z >> 4);
    if (v === null) throw new Error(`withNibbles: column (${x >> 4}, ${z >> 4}) has no set`);
    return v;
  };
  return {
    ...view, store,
    tag: (x, y, z) => {
      view.tag(x, y, z); // the plain view's range checks
      return col(x, z).cave(x & 15, y, z & 15);
    },
  };
}

/**
 * `store` whose writers from `claimColumn` put the fixture's nibble on every tagged byte of `setProto`'s cave channel in
 * place of T's (a copy; the stage's array is left as it is): for a reader that generates its own columns (DT2).
 */
export function nibblingStore(store: VoxelStore, nib: Nibble = nibbleOf): VoxelStore {
  return Object.assign(Object.create(store) as VoxelStore, {
    claimColumn(cx: number, cz: number, epoch: number): ColumnWriter {
      const w = store.claimColumn(cx, cz, epoch);
      return Object.assign(Object.create(w) as ColumnWriter, {
        setProto(sy: number, blocks: Uint16Array, fluid: Uint8Array, cave?: Uint8Array): void {
          if (cave === undefined) return w.setProto(sy, blocks, fluid);
          w.setProto(sy, blocks, fluid, nibbledSection(cave, cx, cz, nib) as Uint8Array);
        },
      });
    },
  });
}

/** `store` writing the plain bytes (every tagged byte its kind alone, T's biome cleared), as `nibblingStore`. */
export function kindsStore(store: VoxelStore): VoxelStore {
  return nibblingStore(store, NONE);
}

/** `view` reading the nibbled cave bytes (header). */
export function withNibbles(view: ColumnView): ColumnView;
export function withNibbles(view: RegionView): RegionView;
export function withNibbles(view: ColumnView | RegionView): ColumnView | RegionView {
  return 'store' in view ? nibbledRegion(view) : nibbledColumn(view);
}

/** `view` reading the plain cave bytes (every tagged byte its kind alone; header). */
export function withKinds(view: ColumnView): ColumnView;
export function withKinds(view: RegionView): RegionView;
export function withKinds(view: ColumnView | RegionView): ColumnView | RegionView {
  return 'store' in view ? nibbledRegion(view, NONE) : nibbledColumn(view, NONE);
}

/** The fixture region (header): its box and seed. */
export const NIBBLE_REGION = { seed: '42', cx0: 545, cz0: 25856, size: 5 } as const;

/** The fixture region: its GenContext (DEFAULTS), its plain view (`withKinds`) and its `withNibbles` view. */
export interface NibbleFixture {
  readonly ctx: GenContext;
  readonly plain: RegionView;
  readonly nibbled: RegionView;
}

let fixture: NibbleFixture | null = null;

/** The fixture region (header), generated on first use. */
export function nibbleRegion(): NibbleFixture {
  if (fixture !== null) return fixture;
  const { seed, cx0, cz0, size } = NIBBLE_REGION;
  const ctx = ctxFor(seed);
  const store = createStore({ shared: false, maxBlockBytes: 64 << 20, maxByteBytes: 32 << 20 });
  genRegionInProcess(store, ctx, cx0, cz0, size, size);
  const view = regionView(store, cx0, cz0, size, size);
  fixture = { ctx, plain: withKinds(view), nibbled: withNibbles(view) };
  return fixture;
}
