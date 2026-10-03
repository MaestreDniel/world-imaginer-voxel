# SP3a — Block registry, voxel store and region harness (Design)

Date: 2026-10-02
Status: Approved by the user (2026-10-02): the design section by section, then the written spec after the adversarial review, including its three additions (slab fuzz gated by its integration test, not a threshold row, §9; `SHAPE` and `SOUND` gain `none` for air, §2.2, §11; the region-cache CI step moves to SP3b, §9, §11). Revised by the implementation-plan dry run (2026-10-03, §13)
Parent: master spec `2026-09-26-architecture-design.md`. The sections involved are:
- §10 SP3, which this spec splits into SP3a, SP3b and SP3c;
- the data model: §2.1 (coordinates and keys), §2.2 (block registry and voxel encoding), §2.3 (the store), §2.5 (key types), §2.6 (byte budgets);
- §3.0 (stage contract), §4.1-4.3 (threads, column states, scheduling) where they constrain the store;
- the testing sections §6.1-6.4 (harness, DT1, M1, slab fuzz) and §7 (bench).
Previous SP: `2026-09-30-sp2b-parameter-tooling-design.md` (§11 there lists what SP2b handed over).

References written "master §x" point to the master spec, "SP2a §x" and "SP2b §x" to those specs, and a bare "§x" to this document.

## Goal

Lay the voxel foundations SP3b's terrain and SP4's renderer build on, and show real voxels already:

- **The block registry and the voxel encoding, frozen from here on:** u16 block states, the fluid byte, the light byte, the property model, the id order and key format, the enum codes and face order, the registry API, the per-state tables and the append-only id rule (master §2.2).
- **The shared voxel store:** two slab pools, each one growable SharedArrayBuffer, with a lock-guarded free stack, refcounts, the column torus, proto and final section descriptors, aux slots and per-scope epoch cells, running unchanged on a plain ArrayBuffer.
- **A provisional T stage** that fills columns from today's 2D world (bedrock, stone, water, air) through the store API.
- **The region harness** `genRegion` (orders, threads, cache, PNG slices), DT1 on the provisional T, and region goldens in `?selftest=1` and Bun.
- **A "Voxels" mode in the cut-line cross-section** of `?map`, showing the real vertical slice of voxels.

## Non-goals

- No density, no real `surfaceEstimate`, no surface rules, no terrain palette beyond air, stone and bedrock, no terrain metrics (T1-T5, S1-S3, B4 voxel parts, DT2), no P1 "T ≤ 4 ms" gate, no aux B (biome quarts): SP3b.
- No draft presets, no node inspector, no slice viewer beyond the cut line's Voxels mode: SP3c.
- No coordinator, no column state machine driven across workers, no streaming, no light, no meshing, no `padded.ts`, no face-to-face connectivity bits, no final heightmaps: SP4.
- No persistence, no `stateTable` in saves, no diff codec, no `PLACEABLE` flag, `category` or `tags.ts` (creative palette): SP5. They arrive as new per-type tables under the §2.1 growth rule.

## Decisions (confirmed by the user, 2026-10-02)

1. **SP3 splits in three.** SP3a: block registry, store, harness and a provisional T stage. SP3b: density DAG, `surfaceEstimate`, the real T stage, surface rules and the terrain metrics. SP3c: draft presets, node inspector and slice viewer. SP4 depends on SP3b; SP3c can run alongside SP4. The context review sized SP3 at 9-12 weeks, three to four times the master's "L".
2. **SP3a shows voxels:** a provisional T stage fills columns from the 2D world, the harness writes PNG slices, and `?map` shows the vertical slice.
3. **The store is complete but has no coordinator.** Everything in master §2.3, with both backends and tested with four threads; in the browser each worker uses its own store for the slice job. Shared streaming across workers is SP4.
4. **The slice reuses the cut line.** The SP2b Cross-section tab gains a `Profile | Voxels` toggle.
5. **Each pool is one growable SharedArrayBuffer.** Whoever runs out of slots grows the pool under the pool's lock; every thread sees the growth. This replaces master §2.3's pages broadcast by the main thread (amended, §11).

## Module layout after SP3a

```
src/core/coords.ts            x/y/z ↔ cx/cz/sy/lx/ly/lz, voxel index, colKey, sectionKey, torus slot, quart coordinates
src/core/hash.ts              + a streaming FNV-1a 64 (§6.2)
src/world/blocks/
  kinds.ts                    property kinds and their values (§2.1 codes)
  registry.ts                 buildRegistry(defs): ids, STATE_TYPE, DEFAULT_STATE, per-state tables, stateKey/parseStateKey,
                              stateOf/propsOf/withProp/withType/rotateState/mirrorState
  defs.ts                     the real block definitions (air, stone, bedrock)
  index.ts                    REGISTRY = buildRegistry(BLOCK_DEFS) and the table aliases
  fluid.ts                    fluid byte helpers
  light.ts                    light byte helpers
src/world/store/
  pool.ts                     a slab pool over one growable buffer: lock, free stack, refcounts, growth
  columnTable.ts              the 64 × 64 torus of 160-int32 column records (status, epoch and versions live here)
  section.ts                  section descriptors, uniform ↔ dense, meta word, section views
  aux.ts                      aux A and aux B layouts
  epochs.ts                   per-scope epoch cells
  store.ts                    createStore({shared, maxBlockBytes?, maxByteBytes?}), attachStore(handles); claimColumn,
                              freeColumn, freeProto, proto/final views, neighborhood (§3.5)
  api.ts                      the types gen may import: ColumnWriter, ColumnView, NeighborhoodReader, AuxView, AuxBView
src/gen/pipeline/terrainStage.ts   the provisional T stage
src/metrics/region.ts         fillColumnT, genRegionInProcess, regionHash (§6.1, §6.2; in DET_FILES)
src/metrics/sp3aGoldens.ts    registry and region goldens (in DET_FILES)
src/workers/                  + the slice job (protocol, handler, worker-local slice store and LRU)
src/engine/workerPool.ts      + pool.slice
src/ui/crossSection/          + the Voxels mode
src/workers/sliceJob.ts       the slice job: worker-local store, 64-column LRU, the sample walk (§5.1)
src/ui/crossSection/voxels.ts the Voxels palette, slice image, hover cells and readout (§5.2)
test/harness/region.ts cache.ts png.ts regionWorker.ts fuzzWorker.ts; nodeWorker.ts takes an entry
test/harness/blockFixtures.ts stateLock.ts registryChecks.ts reviewSlices.ts
test/metrics/blocks.metric.ts (M1) region.metric.ts (DT1)
test/stateIds.lock.json
tsconfig*.json                lib ES2024 (target unchanged): growable SharedArrayBuffer and resizable ArrayBuffer types
```

## 1. Coordinates (`core/coords.ts`)

Master §2.1, as code: integer x and z; y ∈ [−64, 319]; `cx = x >> 4`, `cz = z >> 4`; `sy = (y + 64) >> 4` (24 sections); voxel index in a section `ly << 8 | lz << 4 | lx`; column index in a 16 × 16 map `lz·16 + lx`; quarts `qx = x >> 2`, `qy = (y + 64) >> 2` (96); `colKey = (cx + 32768)·65536 + (cz + 32768)`; `sectionKey = colKey·32 + sy`; torus slot `(cx & 63) + 64·(cz & 63)`. No string keys anywhere. Unit tests pin the round trips and the window edges (the half-open world window `[−2^19, 2^19)` of SP2b §6.3).

## 2. Block registry and encoding (`world/blocks`) — frozen from SP3a

### 2.1 Encoding and conventions

- **Block state:** u16; `MAX_STATES = 4096`, asserted when the registry is built. Type ids and state ids both start at 0 and follow the order of the definitions.
- **Fluid byte:** bits 0-2 level (0 = source … 7), bit 3 falling, bits 4-5 type (0 none, 1 water, 2 lava), bit 6 `unsettled`, bit 7 reserved. A pure fluid voxel is `air` plus a fluid byte. `fluid.ts` packs and unpacks it.
- **Light byte:** `sky << 4 | block`. `light.ts` packs and unpacks it.
- **Directions:** north = −z, south = +z, east = +x, west = −x, up = +y (as `gen/column/steep.ts` and `columnStage.ts` already use). A clockwise quarter turn seen from +y maps a horizontal offset (x, z) to (−z, x): north → east → south → west → north.
- **Faces:** a face index i ∈ 0..5 is the `facing6` value index: 0 north, 1 east, 2 south, 3 west, 4 up, 5 down. `FULL_FACES` bit i is face i; `FACE_TEX[state·6 + i]` is face i's texture.
- **Enum codes:** every enum table stores the 0-based index of its value in the order written here: `PASS` none 0, opaque 1, cutout 2, translucent 3; `SHAPE` none 0, cube 1, cross 2, fluid 3, pointed 4, box 5; `COLLIDE` none 0, cube 1, boxes 2; `FLUID_MODE` block 0, hold 1, displace 2; `TINT` none 0, grass 1, foliage 2, water 3, fixed 4; `SOUND` none 0, stone 1, dirt 2, grass 3, sand 4, gravel 5, wood 6, snow 7, glass 8, leaves 9, metal 10, abyss 11. Property values likewise (§2.2).
- **What is frozen:** these encodings, codes and orders, the property kinds and their value lists, the id order (§2.2), the key format (§2.3), the registry API and the existing tables. The table set only grows: later SPs add block types, per-state values of new states and new tables (`PLACEABLE` and `category` in SP5, `SHAPE_BOXES` in SP8a); an existing table never changes its encoding.

### 2.2 Types, properties and ids

- **Property kinds** (`kinds.ts`), values in kind order with their codes: `axis` (x 0, y 1, z 2), `facing4` (north 0, east 1, south 2, west 3), `facing6` (north 0, east 1, south 2, west 3, up 4, down 5), `half` (bottom 0, top 1), `open` (false 0, true 1), `hinge` (left 0, right 1), `slabType` (bottom 0, top 1, double 2). Connection-derived shapes are not stored; waterlogging is the fluid byte.
- **A block definition** gives its type name, its properties in declaration order (each a name, a kind and a default value; names unique within the type), and its per-state table values (a constant or a function of the state's properties). Type and property names match `[a-z][a-z0-9_]*`.
- **Ids are contiguous per type, the default state first.** Number the property combinations in mixed-radix order: properties in declaration order, values in kind order, the last property varying fastest; let k be a combination's number and d the default's. The type's states take ids `base + 0` for the default, then the other combinations in increasing k: id = `base + (k = d ? 0 : k < d ? k + 1 : k)`. Example: a type with `axis` default y has ids base + 0 (y), base + 1 (x), base + 2 (z). `DEFAULT_STATE[type] = base`.
- **A locked type never changes.** Once a type has entries in the lock (§2.3), its property list (names, kinds, order) and its default are frozen; the kinds' value lists are frozen anyway. A variant that needs another property or value is a new type, appended, and `withType` converts between them. This is how master §2.2's "new types and props only append" is read (amended, §11).
- **API** (`registry.ts`; pure table lookups):
  - `stateOf(type, props)` (missing props take the defaults), `propsOf(state)`, `withProp(state, prop, value)`, `stateKey(state)`, `parseStateKey(key)`.
  - `withType(state, type)` keeps a property only when the target type declares one with the same name and the same kind; every other property takes the target's default.
  - `rotateState(state, quarterTurns)` turns clockwise seen from +y by q = ((quarterTurns mod 4) + 4) mod 4 quarter turns: the horizontal values of `facing4` and `facing6` step north → east → south → west per turn, up and down stay, `axis` swaps x ↔ z when q is odd; `half`, `open`, `hinge` and `slabType` are unchanged.
  - `mirrorState(state, axis)` with axis 'x' negates x (east ↔ west, north and south unchanged) and with 'z' negates z (north ↔ south, east and west unchanged); up and down stay; `hinge` flips left ↔ right on either axis; `axis`, `half`, `open` and `slabType` are unchanged.
- **Per-state tables** (SoA, sized `MAX_STATES`; codes in §2.1): `STATE_TYPE` (Uint16), `OPACITY` (Uint8: 0 | 1 | 15), `PASS`, `SHAPE`, `FULL_FACES` (6 bits), `EMIT` (0-15), `CARVABLE` (0/1), `REPLACEABLE` (0/1), `COLLIDE`, `FLUID_MODE`, `TINT`, `SOUND` (all Uint8), `FACE_TEX` (Uint16 × 6 per state). Per type: `DEFAULT_STATE` and the type name. `SHAPE` and `SOUND` gain `none` for air, which the master's lists lack (amended, §11; added after the section approvals); no placeable state uses `SOUND` none. Box models use `cube` and `FULL_FACES` 63 until SP8a, as the master says.
- **The initial list:** `air` (id 0), `stone` (1), `bedrock` (2), each with one state:

| | OPACITY | PASS | SHAPE | FULL_FACES | CARVABLE | REPLACEABLE | COLLIDE | FLUID_MODE | SOUND | FACE_TEX |
|---|---|---|---|---|---|---|---|---|---|---|
| air | 0 | none | none | 0 | no | yes | none | displace | none | 0 |
| stone | 15 | opaque | cube | 63 | yes | no | cube | block | stone | 0 |
| bedrock | 15 | opaque | cube | 63 | no | no | cube | block | stone | 0 |

  `EMIT` 0 and `TINT` none for all three. Texture ids are 0 until SP8a. SP3b appends the terrain palette.

### 2.3 The append-only lock

- `test/stateIds.lock.json` maps every published state's canonical key to its id.
- **Canonical key:** the bare type name for a type without properties (`stone`); otherwise `name[p1=v1,p2=v2,…]` listing every property of the type, defaults included, in declaration order, joined by commas, with no spaces, each value spelled as its kind value name (`log[axis=y]`; a door declaring facing, half, open and hinge in that order: `door[facing=north,half=bottom,open=false,hinge=left]`). Keys are ASCII and unique; `parseStateKey(stateKey(s)) = s` for every state.
- A unit test fails if an entry of the lock is missing from the registry or has another id. New states not yet in the lock fail too, until `npm run test:accept-state-ids` appends them; that command never rewrites or removes an entry, and it refuses to append a state of a type that already has lock entries (a new property or value on a locked type, §2.2).
- Each commit that changes the lock says so in its message; the lock and its rule are what saves (SP5) rely on.

### 2.4 Tests and M1 (registry parts)

- **A fixture registry** (tests only, never locked) has one type per property kind, plus a type with two properties whose defaults are not the first kind values (`axis` default y, `half` default top), and checks:
  - the exact id sequence of that type (default at base + 0, then the §2.2 order) and `DEFAULT_STATE`;
  - `stateOf`/`propsOf` round trips for every state, `withProp` round trips, `stateKey`/`parseStateKey` round trips and the key of a two-property state;
  - expected values: one quarter turn for every kind (`facing4` north → east, `facing6` up → up, `axis` x → z), each mirror axis for every kind (`mirrorState(facing=east, 'x')` = west, `mirrorState(facing=north, 'x')` = north, hinge left → right), quarterTurns −1 and 5;
  - invariants: `rotateState` four times and `mirrorState` twice are the identity;
  - `withType` keeps a shared property of the same kind and defaults a same-named property of another kind (`facing6` up into a `facing4` type gives the target's default);
  - the `MAX_STATES` assertion and contiguous ids;
  - the lock rule on a fixture copy: a changed id, a removed entry and a new value on a locked type are refused.
- **M1 registry parts** (metric, every tier): used states ≤ 4096; rotations and round trips exact over the real registry and the fixture; lock entries unchanged. The shape part of M1 is SP8a.

### 2.5 Determinism

`world/blocks/**` follows the core rules (the Math allowlist, no `**`, no engine-dependent APIs, no nondeterministic APIs, top-level aliases for imported values): its ids and tables are hashed into goldens. The arch rules and master §1's banned-API scopes gain it (§11). `world/store/**` keeps the ND bans only.

## 3. The voxel store (`world/store`)

### 3.1 Pools

- **Two pools, one implementation:** the block pool (8 KiB slots: a u16 per voxel of a 16³ section) and the byte pool (4 KiB slots: light, fluid, aux A, aux B).
- **Backing:** each pool's slots live in one growable buffer: a `SharedArrayBuffer` created with `maxByteLength` (default 768 MiB for blocks, 512 MiB for bytes; reserved address space, not committed memory), or, with the same code, a resizable `ArrayBuffer`. Atomics work on both.
- **Metadata** per pool, in its own growable buffers: an Int32 lock word, the stack top and slot count, the free stack (Int32 per slot) and the refcounts (Int32 per slot).
- **Slot id** = the slot's index in its pool.
- **Allocation:** take the lock (a compare-exchange spin with `Atomics.wait`-free backoff), pop a slot, set its refcount to 1, release. If the stack is empty, grow the pool by 1 MiB (128 block slots or 256 byte slots) inside the same lock, push the new slots, then pop. A pool at its maximum throws `StoreFull`.
- **Free:** `Atomics.sub` the refcount; at 0 take the lock and push the slot. **Retain:** `Atomics.add`. One free per reference: a slot retained n times is freed n + 1 times.
- **Contents:** a slot is never zeroed on free. Section writers fill whole section slots (§3.3); aux slots are zero-filled by the store when allocated (§3.4).
- **Views:** a thread keeps typed-array views over the growable buffers; length-tracking views see growth without being rebuilt.

### 3.2 Column table

- A fixed buffer of 64 × 64 records × 160 int32 (≈ 2.6 MB); record = torus slot `(cx & 63) + 64·(cz & 63)`.
- Record layout (master §2.3): 0-3 cx, cz, `status` (0 Absent, 1 Proto, 2 Decorated, 3 Published), `epoch`; 4-5 `blockVersion`, `lightVersion`; 6 protoFlags; 7-8 aux A and aux B slots (−1 when not allocated); 9-10 unsettledCount, diffFlag; 11 `claimed` (0 free, 1 held); 16-111 final descriptors (24 × 4); 112-159 proto descriptors (24 × 2); 12-15 unassigned. `status`, `epoch`, `claimed` and the versions are read and written with Atomics.
- `createStore` initialises every record free: `claimed` 0, status Absent, aux ids −1, every descriptor −1 and meta 0.
- **Collisions.** A record holds at most one column. Claiming a column whose record is held (by another column or by the same one) throws `SlotBusy`; the caller frees the holder first (§3.5). A read of a column whose record holds another column, or is free, returns null ("absent").

### 3.3 Section descriptors

- **Final (4 × int32):** blocks (slot, or `-1-stateId` for a uniform section), light (slot, or `-1-byte`), fluid (slot, or `-1-byte`; −1 is "no fluid", byte 0), meta.
- **Meta word:** bits 0-12 `nonAir` (voxels whose state is not air, 0-4096), bit 13 hasOpaque, 14 hasCutout, 15 hasTranslucent (any voxel whose `PASS` is that pass), bit 16 hasFluid (any fluid type ≠ 0), bits 17-31 the connectivity bits, left 0 until SP4. Computed when a final section is written.
- **Proto (2 × int32):** blocks and fluid, with the same encodings.
- **Unwritten descriptors** are −1: uniform air, light byte 0, no fluid. Proto descriptors are read only when status ≥ Proto and final ones only when status ≥ Decorated (asserted in tests).
- **Uniform ↔ dense:** a writer hands a full section; each channel (blocks, light, fluid) is stored on its own: uniform when every value of that channel is equal (no slot), dense otherwise. Reading a uniform section returns the constant. Rewriting a descriptor releases what it held. Uniform fluid (`-1-byte`) is new (§11): a full water section of an ocean costs no slot.
- **Sharing and release.** Every non-negative descriptor entry (proto blocks, proto fluid, final blocks, final light, final fluid) and every allocated aux slot holds one reference. Making a final set share a proto slot retains it, so a shared slot holds two references. Freeing a proto set, a final set or a whole column releases once per such entry: a shared slot is released once by each set. Uniform entries hold no slot and release nothing.

### 3.4 Aux slots and epoch cells

- **Aux A** (one byte slot, exactly 4096 bytes), at byte offsets: `WORLD_SURFACE_WG` 0, `OCEAN_FLOOR_WG` 512, `WORLD_SURFACE` 1024, `MOTION_BLOCKING` 1536, `OCEAN_FLOOR` 2048, `LIGHT_BLOCKING` 2560 (Int16[256] each), `surfaceBiome` 3072 (Uint8[256]), `tintTH` 3328 (Uint8[768]). Per-position arrays use the column index `lz·16 + lx`; Int16 values are little-endian (native on every target).
- **Heightmaps.** A value is the absolute y of the highest qualifying voxel plus one; −64 when none qualifies. Predicates:
  - `WORLD_SURFACE_WG` and `WORLD_SURFACE`: state ≠ air, or fluid type ≠ 0 (water counts);
  - `OCEAN_FLOOR_WG` and `OCEAN_FLOOR`: `COLLIDE[state]` ≠ none; the fluid byte is ignored;
  - `MOTION_BLOCKING`: `COLLIDE[state]` ≠ none, or fluid type ≠ 0;
  - `LIGHT_BLOCKING`: master §2.2's light rule (`FULL_FACES` and `OPACITY`), pinned by SP4.
  SP3a writes only the two `_WG` maps and `surfaceBiome`; the final maps are SP4's.
- **Aux B:** `caveBiomeQ` at 0 (Uint8[1536]) and `surfaceBiomeQ` at 1536 (Uint8[16]); the rest of the slot is 0. SP3a allocates no aux B slot (record int 8 stays −1); SP3b's T fills it.
- **Zero fill.** `ColumnWriter.aux()` and `auxB()` allocate their slot on first call and zero-fill all 4096 bytes, a recycled slot included; a field no stage has written reads 0.
- **Epoch cells:** one Int32 per pipeline phase (`EPOCH_CELL` = terrain 0, decorate 1, light 2, mesh 3) in their own buffer (a `SharedArrayBuffer` when `shared`, an `ArrayBuffer` otherwise). Built and unit-tested in SP3a; no SP3a job reads them. SP4 wires them into the pool in place of the pool-wide abort cell.

### 3.5 API

`api.ts` holds the types `gen` may import (types only): `ColumnWriter`, `ColumnView`, `NeighborhoodReader`, `AuxView`, `AuxBView`. `store.ts` holds the implementation, which `gen` never imports.

- **Store:** `createStore({shared: boolean, maxBlockBytes?, maxByteBytes?})` (defaults 768 MiB and 512 MiB); `store.handles()` returns the buffers, and `attachStore(handles)` rebuilds the same store in another thread.
- **Column lifecycle:**
  - `store.claimColumn(cx, cz, epoch): ColumnWriter` takes the record (compare-exchange of `claimed` 0 → 1; throws `SlotBusy` if held), then writes cx, cz and `epoch`, and leaves status Absent, the versions 0, every descriptor −1 and the aux ids −1. A writer belongs to one thread.
  - `store.freeColumn(cx, cz)` does nothing unless the record holds (cx, cz); otherwise it stores status Absent, releases every reference the record holds (§3.3), resets the entries to −1 and the aux ids to −1, and stores `claimed` 0. It works on committed and on half-written columns.
  - `store.freeProto(cx, cz)` releases only the proto entries and resets them to −1 (master §4.2 proto retention; used by tests in SP3a, by SP4's coordinator later).
  - `store.proto(cx, cz)` and `store.final(cx, cz)` return a `ColumnView`, or null unless the record holds (cx, cz) at status ≥ Proto (respectively ≥ Decorated). `store.neighborhood(cx, cz)` returns a `NeighborhoodReader`.
- **`ColumnWriter`:**
  - `setProto(sy, blocks: Uint16Array, fluid: Uint8Array)`: copies both 4096-entry arrays (callers reuse scratch buffers) into the proto set, per channel uniform or dense (§3.3);
  - `setFinal(sy, blocks: Uint16Array, light: Uint8Array, fluid: Uint8Array)`: copies into the final set and computes meta;
  - `shareFinal(sy, light: Uint8Array)`: the final blocks and fluid become the proto entries (each dense slot retained), the light is stored as by `setFinal`, and meta is computed;
  - `aux(): AuxView` and `auxB(): AuxBView`: §3.4; `AuxView` has the named fields of §3.4 as typed subarrays of the slot (`worldSurfaceWG`, `oceanFloorWG`, `worldSurface`, `motionBlocking`, `oceanFloor`, `lightBlocking`: Int16Array(256); `surfaceBiome`: Uint8Array(256); `tintTH`: Uint8Array(768)), `AuxBView` likewise (`caveBiomeQ`, `surfaceBiomeQ`);
  - `commit(status: 1 | 2 | 3)`: `Atomics.add(blockVersion, 1)`, then `Atomics.store(status)` last, so a reader never sees a partial column.
- **`ColumnView`:** `block(lx, y, lz)`, `fluid(lx, y, lz)`, `light(lx, y, lz)`; `sectionBlocks(sy)` and `sectionFluid(sy)` return a view over the slot or the uniform value; `aux()` returns the column's `AuxView`, or null when it has none.
- **`NeighborhoodReader`:** `proto(dx, dz)` and `final(dx, dz)` over the 3 × 3 neighbourhood (null for an absent column); `versions()` returns an Int32Array(18): the 3 × 3 in (dz, dx) order from (−1, −1), blockVersion then lightVersion per column, −1 for an absent column. Defined now, consumed from SP4.

### 3.6 Tests

- **Slab fuzz** (project `integration`; 4 `worker_threads` running `test/harness/fuzzWorker.ts`, §6.1) on one `createStore({shared: true, maxBlockBytes: 64 MiB, maxByteBytes: 32 MiB})`, 100k random ops per thread on both pools with concurrent growth. The ops:
  - alloc, retain and free of raw slots;
  - rewriting a section as uniform or dense in either direction (promotion and demotion: a dense write allocates, a uniform write over a dense section releases);
  - writing a column's proto set, then its final set through `shareFinal` (sharing) or `setFinal`; `freeProto`; `freeColumn`;
  - claims on torus records with collisions: each thread owns the records whose slot ≡ thread (mod 4) and claims columns 64 apart on them (cx − 64, cx, cx + 64, each at cz and cz + 64), freeing the holder first; lookups of its own records.
  Each thread keeps at most 1,000 live raw references per pool and 8 claimed columns, so at most 5,540 block and 6,372 byte slots are live against 8,192 per pool (48 block and 74 byte slots per column, aux B included, plus one transient slot per thread and pool while a dense rewrite allocates before it frees): `StoreFull` is a failure here, and growth (128 or 256 slots per step) happens many times while the threads race. Checks:
  - 0 double allocations: an alloc never returns a slot that a reference still holds (each thread claims the slot in a shared owner table by compare-exchange on alloc and clears it before its last release);
  - at each barrier and at the end, every slot's refcount equals its raw references plus the descriptor and aux entries that reference it;
  - no lost slots: free-stack size + slots with refcount > 0 = slot count;
  - after teardown every refcount is 0 and the free stack holds every slot;
  - a lookup never returns another column's record.
  The limits are hard assertions in the test (§9).
- **Unit** (the same test file runs against both backends): uniform ↔ dense per channel, both ways; meta bits; proto/final sharing and release: share a slot, free the proto set, then the final set, and separately the whole column, and check that the free-stack size and every refcount return to their values from before the column; `SlotBusy` on a held record, and `freeColumn` then claim succeeds with no leaked slot; reads of a column whose record holds another one return null; descriptor initial values; aux offsets and the zero fill on a recycled dirty slot; `StoreFull` at the maximum; epoch cells; `versions()`; `attachStore` across two threads.

## 4. The provisional T stage (`gen/pipeline/terrainStage.ts`)

- **Signature:** `terrainStage(ctx: GenContext, cx: number, cz: number, w: ColumnWriter, stop: () => boolean): boolean`, following the `stop` convention of `paintTileAbortable` and `findSpawnAbortable`.
- **Per block position** of the 16 × 16 column, from the column's ColumnSample (`buildColumnSample`): `surfaceEst` (still `offset`, bilinear readout) and `surfaceWaterLevel` (nearest-corner readout).
- **Fill, from the bottom:** y = −64 → `bedrock`; y ≤ ⌊surfaceEst⌋ → `stone`; ⌊surfaceEst⌋ < y ≤ surfaceWaterLevel → `air` with a water source (type 1, level 0); above → `air`. This is master §10's v0 water rule restricted to a world without overhangs (there, air exists only above ⌊surfaceEst⌋, so "above surfaceEst − 12" always holds).
- **Order and abort:** sections sy 0 … 23 go to `setProto` in order, each stored uniform or dense per channel; `stop()` is called before each section, and on true the stage returns false at once, without aux or commit. After the sections it writes aux A and returns true.
- **Aux A:** `WORLD_SURFACE_WG` and `OCEAN_FLOOR_WG` by the §3.4 predicates (on land both are ⌊surfaceEst⌋ + 1; under water `WORLD_SURFACE_WG` is the top water y + 1 and `OCEAN_FLOOR_WG` is ⌊surfaceEst⌋ + 1) and `surfaceBiome` (the zoomed biome, SP2a §3.3). Every other aux A field stays 0; no aux B.
- **Callers** use `fillColumnT(store, ctx, cx, cz, stop, epoch = 0)` (`metrics/region.ts`, §6.1): claim the record with `epoch`, run the stage, `commit(1)` (status Proto) on true, `freeColumn` on false, which releases the sections already written and leaves the record free. The harness passes `() => false`; the slice job passes the pool's abort cell (§5.1).
- The `terrain` stage of the registry keeps version 1 and no parameters: no persisted data exists before SP5, no golden reads the real stage list (`sp1.params` hashes `FIXTURE_STAGES`), and a bump would only change `genKey` and the `terrain@1` pin in `test/unit/stage.test.ts`. Because `genKey` therefore does not track the provisional T code, the region cache key carries a source hash (§6.1). SP3b replaces the provisional fill and bumps the stage and `GENERATOR_VERSION`.
- Pure (`gen`) and deterministic; it never reads an epoch cell itself.

## 5. The slice job and the Voxels mode

### 5.1 Worker job

- **Protocol:** `{type: 'slice', jobId, epoch, ax, az, bx, bz}` → `{type: 'sliceResult', jobId, epoch, blocks: ArrayBuffer, fluid: ArrayBuffer}` (transferred). `BAD_ARGS` for an end outside the half-open window or a zero-length segment, as for `crossSection` (SP2b §5.4).
- **Pool:** `pool.slice(segment, priority = 500): Promise<SliceResult>` sends a slice as one job to one worker, never split, at the stats priority (SP2b §5.4); a configure rejects it with `JobCancelled`, and `ABORTED` resolves as `JobCancelled`, as for stats jobs.
- **Samples:** sample (i, y) reads the voxel (⌊xᵢ⌋, y, ⌊zᵢ⌋), where (xᵢ, zᵢ) = `segmentPointAt(segment, i)` (SP2b §4.5: A + (B − A)·i/511, clamped to the segment's box), for i 0 … 511 and y −64 … 319.
- **Buffers:** `blocks` is a Uint16Array and `fluid` a Uint8Array, 512 × 384 = 196,608 entries each, index (319 − y)·512 + i: row 0 is y 319, the order the Voxels mode draws in.
- **Slice store:** each worker creates its own store on its first slice job, `createStore({shared: false, maxBlockBytes: 32 MiB, maxByteBytes: 16 MiB})` (65 proto columns need at most 1,560 block and 1,625 byte slots), and keeps it for its lifetime. An LRU keyed by `colKey` holds at most 64 columns of one configured epoch; a configure frees every resident column and empties the LRU.
- **Generation:** the worker walks the samples in order; a straight segment enters each column once, so a column's samples are contiguous. On reaching a new column it checks the abort cell, then takes the column from the LRU, or on a miss: frees (`freeColumn`) and drops the LRU column that holds the same torus record, if any; frees and drops the least recently used column if 64 are resident; then runs `fillColumnT` with `stop` and the job's epoch. It reads all of that column's samples before moving on, so it never needs two columns of one torus record at once and `claimColumn` never throws `SlotBusy` here.
- **Abort:** `stop` is true once the pool's abort cell leaves the job's epoch (the handler's `NEVER` when the cell is null, SP2b §2.2). A stopped column is freed by `fillColumnT`, not inserted into the LRU, and the job replies `ABORTED`.

### 5.2 UI

- The Cross-section tab gains a `Profile | Voxels` toggle; the line tool and the refresh rules are those of the profile (requested on `onSettled` while visible, stale from the next session change, abortable).
- Voxels draws one pixel per sample (512 × 384, row 0 at y 319), scaled to the drawer: air in a sky colour, stone grey, bedrock near black, water blue darkening with depth below the water surface, and the sea-level line at 63.
- Hover reads the integer (⌊xᵢ⌋, y, ⌊zᵢ⌋), the block name and the fluid (type, level).
- Pure parts (colours, hover mapping) are unit-tested; `uiSmoke.ts` gains the toggle.

## 6. Region harness, DT1 and goldens

### 6.1 `genRegion` (`test/harness/region.ts`) and its core in `src`

```ts
genRegion({ seed, params, cx0, cz0, w, h, upTo: 'T', order: 'spiral' | 'shuffled', threads: 1 | 4, cache?: boolean, shuffleSeed?: number })
  → { view: RegionView, timings: { perColumnMs: Float64Array, totalMs: number }, cacheHit: boolean }
```

- **Core in `src`:** `src/metrics/region.ts` (in `DET_FILES`) exports `fillColumnT(store, ctx, cx, cz, stop, epoch = 0): boolean` (§4), `genRegionInProcess(store, ctx, cx0, cz0, w, h)` (`fillColumnT` with `() => false` for every column, cz outer, cx inner) and `regionHash` (§6.2). The goldens (§6.4), the slice job (§5.1) and the harness share them; `src` never imports `test/`.
- **Region:** 1 ≤ w, h ≤ 64 (asserted; a larger region would collide on the torus).
- **Column list:** the main thread builds it. `spiral` starts at (cx0 + ⌊w/2⌋, cz0 + ⌊h/2⌋) and walks outward in square rings, skipping columns outside the region. `shuffled` is a Fisher-Yates permutation of the row-major list (cz outer) drawn from `Xoshiro128(shuffleSeed ?? 1)` (`core/rng.ts`); the seed is printed when DT1 fails.
- **1 thread:** a plain `ArrayBuffer` store (`createStore({shared: false})`), `fillColumnT` per column in list order, in-process.
- **4 threads:** a growable `SharedArrayBuffer` store and 4 `worker_threads` running `test/harness/regionWorker.ts`. `buildNodeTaskWorker(dir, {entry?, stamp?})` is generalised to bundle any entry (default `src/workers/taskHandler.ts`); the harness entries `regionWorker.ts` and `fuzzWorker.ts` are never part of `src/workers/protocol.ts`. A region worker receives `{type: 'attach', handles, seedText, params}` once (`attachStore` and `createGenContext`), then `{type: 'column', cx, cz}` messages, and replies `{type: 'done', cx, cz, ms}` after `fillColumnT`. The main thread hands the next column of the list to whichever worker is idle (a dynamic queue), so every column is written by exactly one thread and `order` sets the dispatch order.
- **`RegionView`** reads proto data through the store: `block(x, y, z)`, `fluid(x, y, z)`, `biome(x, z)`, `worldSurfaceWG(x, z)`, `oceanFloorWG(x, z)`, and the descriptors per column. It never stitches the region into one array (a 32 × 32 region would be about 300 MB).
- **Cache** (`test/harness/cache.ts`):
  - `cache: false` (the default) never reads or writes a dump. `cache: true` reads the dump on a hit (`cacheHit` true); on a miss it generates and writes the dump.
  - Key: `genKey + srcKey + REGION_CACHE_FORMAT + (cx0, cz0, w, h) + upTo`, as a file `test/.cache/regions/<hex64 of the key>.bin`. `srcKey` is the FNV-1a 64 of the sorted paths and bytes of `src/core/**`, `src/world/**`, `src/gen/**`, `src/metrics/region.ts` and `test/harness/cache.ts`, read at test time, so any code change is a miss without a hand-bumped constant. `REGION_CACHE_FORMAT` (an integer in `cache.ts`, starting at 1) is bumped when the dump layout changes.
  - Dump: a header (format, genKey, srcKey, cx0, cz0, w, h, upTo), then per column, cz outer and cx inner: record ints 0-15, the 24 proto descriptors, the dense block and fluid slots they reference in descriptor order, and the 4096 aux A bytes. A header that disagrees with the key is a miss and the file is overwritten.
  - A hit rebuilds each column through the writer API (`claimColumn`, `setProto` per section with the expanded data, the aux bytes, `commit(1)`), so uniform and dense decisions are made again by the same code.
- **PNG slices** (`test/harness/png.ts`): a small PNG encoder over `node:zlib`; vertical slices (an x or z plane) and horizontal slices (a y plane), with the Voxels palette of `ui/crossSection/voxels.ts` (one palette for the PNGs and the page). The review slices of §12 are written by `npm run docs:review-slices` (`test/harness/reviewSlices.ts`, an env-gated unit test) into `docs/superpowers/specs/assets/sp3a/`.

### 6.2 Region hash

`regionHash(store, cx0, cz0, w, h): Hash64` in `src/metrics/region.ts`, over any sub-window of a generated region. FNV-1a 64 through a streaming form added to `core/hash.ts` (its result equals `fnv1a64Bytes` over the concatenated bytes; unit-tested), in this order:

```
for cz = cz0 … cz0+h−1 (outer), for cx = cx0 … cx0+w−1:
  for sy = 0 … 23: the 4096 proto block states in voxel-index order, u16 little-endian (uniform expanded);
                   then the 4096 proto fluid bytes (uniform expanded, −1 as 0)
  then the column's 4096 aux A bytes (unwritten fields are 0, §3.4)
```

It does not depend on generation order, thread count, backend or slot layout. The goldens' value is `hex64` of it.

### 6.3 DT1 (metric, every tier)

Threshold: exact (0 mismatches). Two parts:

1. **Invariance**, on the tier's region (fast: 8 × 8 at (−4, −4); quick and full: 32 × 32 at (−16, −16)), for the profiles default and large_biomes and the tier's seeds (fast '42'; quick '42'; full '42', '1', '2', '3'; the plan's dry run measures the full tier and may lower its seed count, never below two). Five runs per (profile, seed) give equal region hashes: spiral / 1 thread / cold; shuffled / 4 threads / cold; a second spiral / 1 thread / cold run; and two `cache: true` runs, of which the second must report `cacheHit`. Cold means `cache: false`.
2. **Golden**, in every tier: in the seed '42' cold spiral run of each profile, the hash of the 8 × 8 window at (−4, −4) (the whole region in fast, a sub-window of the 32 × 32 region in quick and full) equals `sp3a.region.T.<profile>`. No 32 × 32 golden is recorded.

### 6.4 Goldens

- New file `metrics/sp3aGoldens.ts` (in `DET_FILES`), chained into `allGoldenKeys`/`computeAnyGolden`, so `?selftest=1`, the Bun tool and the integration tests pick the keys up:
  - `sp3a.registry`: FNV-1a 64 over, for each of the states SP3a registers (ids 0-2, a fixed count, not "every state"), its canonical key's ASCII bytes and a 0 byte, then `STATE_TYPE` (u16 little-endian), `OPACITY`, `PASS`, `SHAPE`, `FULL_FACES`, `EMIT`, `CARVABLE`, `REPLACEABLE`, `COLLIDE`, `FLUID_MODE`, `TINT`, `SOUND` (u8 each) and the six `FACE_TEX` entries (u16 little-endian);
  - `sp3a.region.T.default` and `sp3a.region.T.large_biomes`: `regionHash` of the 8 × 8 region at (−4, −4), world seed '42' (as the SP1 and SP2a goldens), generated in process by `genRegionInProcess` on an `ArrayBuffer` store; goldens never use the cache.
- Appending states (SP3b's terrain palette and later) does not change `sp3a.registry`, which covers only SP3a's states: appending is not a generator change and needs no `GENERATOR_VERSION` bump (that would invalidate every `genKey`). The append-only lock guards the existing ids; each later SP adds its own registry golden over the states it appends.
- The hard-coded count 47 goes: `test/unit/goldens.sp2a.test.ts` asserts 50 (47 + the 3 sp3a keys) and the new sp3a unit test asserts `sp3aGoldenKeys().length === 3`. `test/tools/uiSmoke.ts` runs under plain Node and cannot import `src/` (extensionless specifiers; SP0 open items): it matches `/^✓ all (\d+) goldens match/` and compares the count with the number of entries in `test/goldens.json`.
- No existing golden changes; `GENERATOR_VERSION` stays 3.

## 7. Bench

New rows, gated at +30 % like the rest: `store.alloc` (one alloc and free on the byte pool) and `terrain.provisional` (one column's provisional T stage including its ColumnSample). The dense-section write is covered by the unit tests and gets no gated row. A unit test checks that `test/baselines.json` holds exactly the gated rows.

`npm run bench:record` rewrites every row, so the record is made on the reference machine with nothing else loading the CPU, in this order: `npm run bench` against the SP2b baseline (the existing rows must pass), `npm run bench:record`, then `npm run bench`. The record refuses to write when the absolute P1 gate (column p50 ≤ 0.7 ms) fails.

## 8. Tests (summary)

- **Unit:** coordinates; the registry (fixture and real: ids, keys, rotations, mirrors, `withType`, the codes), the lock rule, fluid and light bytes; the store on both backends (§3.6); the streaming FNV against `fnv1a64Bytes`; the provisional T stage (fill rule at sea, on land, under lakes and rivers; heightmap values per §4; uniform sections; abort: `stop` before section k returns false, and after `freeColumn` the free-stack sizes are back and the record is free); the slice job (`BAD_ARGS`, sample points and the buffer index, LRU eviction and reconfigure, byte equality with `RegionView` at (⌊xᵢ⌋, y, ⌊zᵢ⌋), and a line whose columns all share torus record 0, A = (0, 0), B = (523264, 0), refreshed 10 times with byte-equal results and flat live-slot counts); the Voxels palette and hover; region hash invariance and sub-windows on a small region; cache hit, miss on a changed `srcKey` and a mismatched header.
- **Integration** (project `integration`, sequential): slab fuzz (alloc/retain/free, promotion, sharing, torus); the 4-thread harness against the 1-thread one.
- **Metrics:** DT1 and M1 (registry parts), every tier.
- **Arch:** `world/blocks` under the determinism rules; `gen` imports only types from `world/store/api.ts`; `metrics/region.ts` and `metrics/sp3aGoldens.ts` in `DET_FILES`; `CURRENT_SP` follows the §9 rule.
- **Tools:** `uiSmoke.ts` toggles Voxels and checks a non-empty slice; `npm run docs:review-slices` writes the review PNGs.

## 9. Governance

- `SubProjectId`, `SUB_PROJECTS` and the `SP_DEPS` key order replace `'SP3'` in place with `'SP3a'`, `'SP3b'`, `'SP3c'`, in that order, before `'SP4'`; the hard-coded order in `test/arch/sp.test.ts` and the "arrives in SP3" message test follow. `SP_DEPS`: SP3a ← SP2b, SP3b ← SP3a, SP3c ← SP3b, SP4 ← SP3b, SP6 ← SP3b, SP5.
- The first commit appends `'SP3a'` to `STARTED_SPS`, sets `CURRENT_SP = 'SP3a'`, accepts the thresholds lock and appends to the Threshold log.
- The profiles with `readyFrom: 'SP3'` (archipelago, amplified, floating_islands) move to `'SP3c'`, where their drafts are made; they stay hidden until then.
- **Profile readiness while SP3c runs alongside SP4.** A profile is selectable once its `readyFrom` SP has started. `CURRENT_SP` is therefore the last SP of the longest prefix of `SUB_PROJECTS` whose members have all started; an arch test checks it against `STARTED_SPS`. If SP4 starts before SP3c, `CURRENT_SP` stays `'SP3b'` and the SP3c profiles stay hidden; `isProfileReady` is unchanged.
- New threshold rows (`activeFrom: 'SP3a'`), each with a lock accept and a Threshold-log line: DT1 (mismatches max 0); M1 registry parts (states max 4096, rotation and round-trip failures max 0, lock changes max 0).
- **Slab fuzz is gated by its integration test** (double allocations 0, lost slots 0, refcount mismatches 0, non-zero final refcounts 0, as hard assertions), not by a threshold row: `ThresholdTable` is keyed by `MetricId`, and slab fuzz is a store test (master §6.3), not a metric. This departs from the approved "slab fuzz threshold row"; making it a row would need a new `MetricId` and a master §6.4 amendment.
- **CI region cache:** SP0 and master §10 put the `actions/cache` step for `npm run test:metrics` in SP3, when the region cache exists. It moves to SP3b (amended, §11): SP3a's provisional T regenerates a 32 × 32 region in about a second, and DT1's cold runs regenerate anyway. In SP3a the region cache is local only.
- No golden changes; `GENERATOR_VERSION` stays 3.

## 10. Notes handed to SP3b, SP3c, SP4 and SP5

- **SP3b:**
  - T3 needs a redefinition before it can gate: SP2a measured 2.38 on 2D relief because mountain biomes are steep by construction;
  - T1's largest 10-block band is about 33 % before σ and jag (limit 25 %), so the lowland knots probably need a retune;
  - moving the biome height filter to the real `surfaceEst` puts the 3D search into the column stage (≈ 0.8 ms against the 0.7 ms gate) and into every map pixel (the 300 ms preview): plan a cheap surface for the map and the share preview;
  - pin every Expr op's exact semantics and interval rule before SP6 builds caves on them; decide whether J uses the z or the u noise value;
  - the terrain palette appends to the registry and the lock, with an `sp3b.registry` golden over the appended states (§6.4);
  - the real T writes aux B (biome quarts) and the general v0 water fill (air at y ≤ surfaceWaterLevel above surfaceEst − 12 becomes water sources; SP3a's rule is its no-overhang case), and the `islands` DAG term (−1e6 by default) is part of the default expression;
  - the CI `actions/cache@v6` step for `test/.cache/regions` only (never the bundled `test/.cache/taskHandler*` files), before `npm run test:metrics`, keyed by `hashFiles('src/**', 'test/harness/**', 'package-lock.json')` with no `restore-keys`;
  - SP2a minors 5 (a no-allocation heap assertion; lakes and steep allocate per call) and 6 (`B2.dryRiverBiome` is 0 by construction);
  - the ocean-floor σ/jag stripe (SP2b §11), lake rims' islets and the shoreline zoom fringe (SP2a §10).
- **SP3c:** archipelago (≈ 60 % ocean) cannot pass B1's 45 % ocean-family cap: decide per-preset gating; amplified's offset multiplier cannot be baked into the offset spline without raising its 320 range; the floating_islands, amplified and archipelago drafts and the islands surface-rule branch.
- **SP4:** shared streaming across workers on this store, the coordinator and column state machine, `padded.ts` and the connectivity bits, the final heightmaps (`LIGHT_BLOCKING` pinned with the light rule), and replacing the pool-wide abort cell with the store's per-scope epoch cells (master §4.3). If SP4 starts before SP3c, keep `CURRENT_SP` at `'SP3b'` (§9).
- **SP5:** `PLACEABLE`, `category` and `tags.ts` as new per-type tables (§2.1 growth rule); `stateTable` in saves uses the §2.3 canonical keys.

## 11. Master-spec amendments made with this spec

- **§10:** SP3 splits into **SP3a — Block registry, voxel store and region harness** (M; SP2b; exit: DT1 on the provisional T, M1 registry parts, slab fuzz extended to promotion, sharing and the torus, `?selftest=1` with the sp3a region hashes), **SP3b — Density, surfaceEstimate, terrain and surface rules** (L; SP3a; the density DAG with the `islands` term, the real T with the general v0 water fill, the terrain metrics, DT2, P1 T ≤ 4 ms, the region-cache CI step) and **SP3c — Draft presets, inspector and slice viewer** (M; SP3b; the floating_islands, amplified and archipelago drafts with the islands surface-rule branch; the deliverable "live terrain cross-sections and the node inspector"; cut line: inspector pins → SP10). SP4 and SP6 depend on SP3b; SP3c can run alongside SP4. The critical path becomes SP2b → SP3a → SP3b → SP4.
- **§10 SP0 (and the SP0 spec's CI note):** the region-cache step for `npm run test:metrics` arrives in SP3b, caching `test/.cache/regions` only.
- **§1 (module layout):** `core/` gains `coords.ts` contents as in §1 here and a streaming FNV in `hash.ts`; `world/blocks/` is `kinds, registry, defs, index, fluid, light` (`states`, `shapes`, `tags` and `fluidRules` arrive with the SPs that need them); `world/store/` is `pool` (replaces `slab`), `columnTable` (holds the versions; no `versions.ts`), `section, aux, epochs, store, api` (`padded.ts` stays SP4); `gen/pipeline/terrainStage.ts`, `metrics/region.ts` and `metrics/sp3aGoldens.ts` are new; `test/` adds `harness/{region,cache,png,regionWorker,fuzzWorker}.ts` and `stateIds.lock.json`.
- **§1 (banned-API scopes):** the determinism rules also cover `world/blocks/**`; `DET_FILES` gains `metrics/region.ts` and `metrics/sp3aGoldens.ts`.
- **§2.1:** the compass convention (north = −z, east = +x) and the face order (the `facing6` order).
- **§2.2:** `SHAPE` and `SOUND` gain `none` (air; `SOUND` none is never played); the enum codes, the id order (default first, then mixed-radix), the canonical key format and the `withType`/`rotateState`/`mirrorState` rules of §2.1-2.3 here; "new types and props only append" means new types with their full property sets append and locked types never gain properties or values; the table set only grows (later tables such as `PLACEABLE`, `category` and `SHAPE_BOXES` are added, existing ones never change).
- **§2.3:** each slab pool is one growable buffer (`SharedArrayBuffer` with `maxByteLength`, or a resizable `ArrayBuffer`), grown by whichever thread runs out of slots, under the pool's lock, by 1 MiB; a slot id is the slot's index; there is no page broadcast. Uniform fluid sections are encoded `-1-fluidByte` (−1 stays "no fluid"). Record int 11 is `claimed`; claiming a held record throws `SlotBusy`. The meta word's bit positions, the aux A and B offsets and the heightmap encoding and predicates of §3.3-3.4 here; aux slots are zero-filled on allocation. The face-to-face connectivity bits and `padded.ts` are SP4.
- **§2.5:** `SubProjectId` has `'SP3a' | 'SP3b' | 'SP3c'` instead of `'SP3'`. `ColumnWriter` is `setProto`, `setFinal(sy, blocks, light, fluid)`, `shareFinal(sy, light)`, `aux()`, `auxB()`, `commit(status)`, obtained from `store.claimColumn`; `ColumnView` and `NeighborhoodReader` as in §3.5 here.
- **§10 cut lines:** SP3a names no cut line; SP3b's deliverable is voxel terrain from the density DAG with surface rules and water, in the harness slices and the Voxels mode; SP3b's cut line and SP3c's exit are set by their specs.
- **Every other master reference to SP3** (§3.7, §3.17, §8 risk 1, §10's SP2a header and SP2b hand-over, the cut-line receivers, the parallelism and visible-value paragraphs, SP12's continental line) names the part it now belongs to: SP3a, SP3b or SP3c. The SP0 spec's open item "Running TypeScript in `worker_threads` for the harness (SP3)" is resolved by bundling (`buildNodeTaskWorker(dir, {entry?, stamp?})`).
- **§6.1:** `RegionView` reads through the store per column and is never stitched into one array; SP3a's `genRegion` has `upTo: 'T'` only, `cache?` and `shuffleSeed?`, and no coordinator prerequisite rules until SP4. The region cache key adds `srcKey` and a format version to `genKey + region + upTo`, because `genKey` does not track code changes made without a stage bump.

## 12. Exit criteria

| criterion | checked by |
|---|---|
| build, tests and full metrics with DT1 and M1 active | `npm run build && npm test && npm run test:metrics:full` |
| CI green | GitHub Actions |
| slab fuzz: 4 threads × 100k ops, both pools, growth, promotion, sharing, torus; 0 double allocations, 0 lost slots, exact refcounts, all back to 0 | integration test (hard assertions, §9) |
| M1 registry parts; the lock unchanged | metric M1, lock test |
| DT1 exact at `upTo: 'T'` (invariance and golden parts) | metric DT1 |
| `sp3a.*` goldens recorded; no other golden changes; `?selftest=1` all keys in Chrome and Firefox; Bun all keys | goldens tests, browsers, Bun tool |
| bench within +30 % with the new rows | `npm run bench` |
| visual review | three vertical harness PNG slices, one across a coast, one across a lake and one across a river, and a horizontal slice at y 62, written by `npm run docs:review-slices` into `assets/sp3a/`; a screenshot of the Voxels mode (`uiSmoke.ts --shots`) |

## 13. Changes made by the implementation-plan dry run (2026-10-03)

The plan was dry-run in a scratch worktree: every task was implemented and every test and metric tier run. These are the resulting changes to the approved spec:

1. **Slab fuzz bounds** (§3.6). The live-slot bound counts aux B and the transient slot of a dense rewrite: at most 5,540 block and 6,372 byte slots (was 5,536 and 6,336), still under 8,192. Each thread's columns also vary cz, because a lookup that ignored cz passed with cx variants alone.
2. **Bench procedure** (§7). `bench:record` rewrites every row and refuses to write when the P1 absolute gate fails, so it needs a quiet machine and the order bench → record → bench (as SP2b §9). A unit test pins the baseline's rows.
3. **Master amendments** (§11). SP3a names no cut line; SP3b's deliverable is stated and its cut line and SP3c's exit are left to their specs. Every other master reference to SP3 names its part, and the SP0 spec's `worker_threads` open item is resolved.
4. **Review slices** (§6.1, §8, §12). Three vertical slices (coast, lake, river: the known seed-'42' sites lie about 1,300 columns apart, beyond one 64-column region) and one at y 62, written by `npm run docs:review-slices` into `assets/sp3a/`. The PNGs and the Voxels mode share one palette, in `ui/crossSection/voxels.ts`.
5. **Module layout** (Module layout). `workers/sliceJob.ts`, `ui/crossSection/voxels.ts`, the test harness files (`blockFixtures`, `stateLock`, `registryChecks`, `reviewSlices`) and the two metric files are listed; the tsconfig `lib` moves to ES2024 for the growable-buffer types (the target is unchanged).
6. **Measured, unchanged:** DT1's full tier keeps the four seeds (≈ 130 s cold, after the streaming FNV was made about 8 × faster, bit-identical); the provisional T column costs ≈ 0.67 ms on the reference machine; the 4-thread harness, the slab fuzz (≈ 2 s) and the 10-refresh torus slice test run as specified.

## Exit evidence

Implementation of the plan (2026-10-03, branch `sp3a/blocks-store-harness`, Tasks 1-16; 12th Gen Intel(R) Core(TM) i7-12700H with 20 threads, Node v24.21.0, Chrome 153.0.8010.36). Every number below was measured on this branch.
- `npm run typecheck`, `npm run build` (run by the smoke test) and `npm test` (121 files and 1575 tests passed, 3 skipped, 42 s) are green. `npm run test:metrics` (61 s) and `npm run test:metrics:full` (146 s, with the region dumps of earlier runs partly present) are green with DT1 and M1 active.
- `git diff main -- test/goldens.json` adds exactly `sp3a.registry` 5e1febd88b449b63, `sp3a.region.T.default` 943479d09e0e89e3 and `sp3a.region.T.large_biomes` e20fb4ebf0a5e9fc; no other golden changed. `GENERATOR_VERSION` stays 3.
- Slab fuzz (integration, `SLAB_FUZZ_SEED=1`): 4 threads × 100k ops on both pools, 1.5 s; the pools grew to 3840 block and 3840 byte slots; 0 double allocations, 0 lost slots, exact refcounts at every barrier and 0 after teardown (hard assertions). The 4-thread harness equals the 1-thread one in every order, for both profiles.

| metric | fast | quick | full |
|---|---|---|---|
| DT1.mismatches | 0 | 0 | 0 |
| DT1 regions (5 runs × 2 profiles × seeds) | 10 (8 × 8) | 10 (32 × 32) | 40 (32 × 32; seeds '42', '1', '2', '3') |
| M1.states | 3 | 3 | 3 |
| M1.roundTripFailures | 0 | 0 | 0 |
| M1.lockChanges | 0 | 0 | 0 |

DT1 on the full tier takes 43 s alone with the dumps of an earlier run present (8 first cache hits) and keeps its four seeds (§6.3). Every other metric equals its SP2b value.

Bench (`npm run bench`; 20 kernels, 2 of them new in SP3a). The baseline was recorded on the quiet machine in Task 15 (`npm run bench:record`: killRatio 0.821), and three `npm run bench` runs against it passed (the last two: killRatio 0.845 and 0.830; `column.sample` p50 0.339 and 0.409 ms, p99 ≤ 0.545 ms). The new rows in the recorded baseline:

| kernel | ns/eval | ratio to calibration |
|---|---|---|
| `calibration.fmix32` | 0.636 | 1 |
| `store.alloc` (SP3a; one byte-pool alloc and free) | 174.532 | 274.532 |
| `terrain.provisional` (SP3a; one column with its ColumnSample) | 656385 | 1032470.415 |

JavaScriptCore: `npx --yes bun@1 test/tools/goldensJsc.ts` → `50/50 match on Bun 1.4.2 (JavaScriptCore)`.

Browser checks (`node test/tools/uiSmoke.ts --shots <dir>`: its own build, `vite preview` on a free port and headless Chrome 153, 1400 × 900 at DPR 1; 49 s) → `smoke: 77/77 checks pass`:
- `?selftest=1`: `✓ all 50 goldens match (5.7 s)`, and `test/goldens.json` holds 50 entries.
- The Voxels mode on the line A (−12800, 0) → B (12800, 0): "ground top y 26 to 203 · water on 14.6 % of the line, up to 37 deep", 38 colours in the 512 × 384 slice, hover "(25, 12, 0) · stone · no fluid · point 256, 12825.0 blocks from A"; back to Profile, the profile is kept.
- No page error apart from the favicon.ico 404.
- Firefox (`?selftest=1` 50/50) and CI are checked after the merge, as in SP2b.

Visual review (`docs/superpowers/specs/assets/sp3a/`; world seed '42', default profile, provisional T; air in sky blue, stone grey, bedrock near black, water blue darkening with depth). The slices are written by `npm run docs:review-slices` (`test/harness/reviewSlices.ts`). Each site's line is checked against the ColumnSample's land, sea, lake and river positions, and its crop is checked to remove only air and stone. `slices.json` lists the sites and the positions each line crosses.
- `slice-coast.png` (1024 × 192, y −64 … 127): the z plane −31992 for x −27136 … −26113. The sea is up to 43 deep; a river mouth crosses the coast; a 27-column land strip rises to y 100 before the sea again. Line positions: 567 sea, 436 land, 21 river.
- `slice-lake.png` (2 px per block, y 32 … 95): the same plane for x −16384 … −15873. A river channel at sea level 63 lies beside a lake whose water stands at y 70, above sea level. Line positions: 138 lake, 30 river, 344 land.
- `slice-river.png` (2 px per block, y 32 … 95): the same plane for x −15552 … −15041. Three river channels with water up to y 63, at most 4 blocks deep, between land up to y 76. Line positions: 95 river, 417 land.
- `slice-y62.png` (1024 × 1024): the y plane 62 of the 64 × 64 columns from (cx, cz) = (−1696, −2032), with north at the top. It shows the coastline, river channels, islets and enclosed water: water where the sea or a river reaches y 62, stone where the ground does.
- `cross-section-voxels.png` (1400 × 900, the smoke test's `--shots`): `?map` with the Voxels mode on a coast line A (5122, 3074) → B (6658, 3074) at 4 blocks/px. The sea is up to 41 deep under the sea-level line, the badlands rise to y 208, and the hover reads a water source.

## Threshold log

(One line per commit that changes `test/thresholds.lock.json`.)

- Task 1: `STARTED_SPS` gains `SP3a` (SP3 split into SP3a, SP3b and SP3c); no threshold rows change.
- Task 12: new rows `DT1.mismatches` max 0 (§6.3) and M1 registry parts `M1.states` max 4096, `M1.roundTripFailures` max 0, `M1.lockChanges` max 0 (§2.4), active from SP3a, the same on every tier.
