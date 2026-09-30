# SP2b — Parameter tooling (Design)

Date: 2026-09-30
Status: Written for review (design approved section by section by the user, 2026-09-30; revised after an adversarial spec review the same day)
Parent: master spec `2026-09-26-architecture-design.md`. The sections involved are:
- §10 SP2b (deliverable, exit, cut line) and the SP2a cut-line items it receives;
- the parameter and UI sections: §2.7 (presets, session, URL), §3.10 (biome fitness), §5.1-5.4, §5.6;
- the engine sections: §4.3 (epoch cells, scheduling);
- the testing and performance sections: §6.3, §6.4 (U2), §7.
Previous SP: `2026-09-28-sp2a-column-stage-map-design.md` (§10 there lists what SP2a handed over).

References written "master §x" point to the master spec, "SP1 §x" and "SP2a §x" to those specs, and a bare "§x" to this document. Review minors inherited from SP1 and SP2a are listed with their disposition in Appendix A and cited as "SP1 minor n" or "SP2a minor n".

## Goal

Make the generator tunable from the UI: every parameter, spline and biome box of `ParamSchema` is editable on the `?map` page, and the map previews the edited draft live.

- A **draft model** in `WorldSession`: per-path edits and resets over the profile, a minimal canonical patch, atomic loads, gestures, change subscriptions and a global undo/redo history.
- A **live preview pipeline** that shows the draft on the map within 300 ms of an edit, never blanks the map, and keeps up with continuous drags: cooperative abort of stale worker jobs through a SharedArrayBuffer epoch cell, fallback tiles, a one-cycle-at-a-time preview driver and preview-only requests while interacting.
- A **schema-generated parameter panel** with scope badges, modified dots, per-parameter and per-section reset, tooltips and cross-field lints.
- A **nested Hermite spline editor** in a drawer under the map: tree and breadcrumbs from the typed coords, draggable knots and tangent handles, numeric entry, add, delete, nest and flatten, auto tangents, a coordinate histogram and per-segment land and world shares, shape export and import.
- A **biome table editor** with map highlighting of the hovered row, and (cut line) a biome share preview.
- A **presets UI** over the SP1 `wi10-preset` envelope: export writes the draft to a file, import loads a file.
- The **1-10 biome-size slider** (user request 2026-09-29).
- **U2** (parameter liveness) for every column-scope leaf, and the inherited review minors the editor or the pipeline make reachable (Appendix A).

## Non-goals

- No 3D world, no Apply button and no draft/applied split: the map always shows the draft (decision 2). Apply arrives in SP4 with the 3D world.
- No preset library: presets are files, and the URL holds the draft (decision 6). A named library in IndexedDB arrives with SP5's persistence layer.
- No new schema leaves beyond `unit` metadata on the three spline leaves, no retune of defaults and no `GENERATOR_VERSION` bump. Tuning the world (for example oceans that read as seas rather than continents, SP2a Exit evidence) is what the tooling enables, as separate changes after SP2b.
- No metrics dashboard, seed sweep or U3 (SP10); no density inspector (SP3); no keyboard or screen-reader work on the map canvas beyond native form controls (SP4 help, SP10).
- The `?lab=noise` page keeps its SP1 behaviour; its minors stay deferred (Appendix A).

## Decisions (confirmed by the user, 2026-09-30)

1. **One sub-project with a cut line.** SP2b stays one spec and one plan, as the master lists it. The cut line (master §10) is the biome share preview and the cross-section profile (→ SP10); both are the last tasks of the plan.
2. **Live preview of the draft.** Every edit updates the map (coalesced while dragging). The session, the URL and preset export always reflect the draft. There is no Apply in SP2b; master §5.1 is amended (§10).
3. **Layout.** The `?map` page grows into the editor: a toolbar, the map, a resizable side panel with tabs (World, Parameters, Biomes, Presets) and a resizable drawer under the map for the spline editor. Each editor is a module SP4 can mount in the game.
4. **Global undo/redo over the draft.** One history for everything that changes the draft: panel, splines, biome table, slider, seed, profile, preset loads and URL edits. 100 steps; one drag is one step.
5. **Tangents are data.** Moving a knot never changes a tangent; tangents change only by their handle, their numeric field or an explicit "auto tangents" action (per node and per spline). A new knot gets the automatic tangent.
6. **Presets are files plus the URL.** Export downloads a `.wi10-preset.json`; import loads one with inline errors; a bookmark of the URL keeps a draft.
7. **Preview pipeline: abort and keep stale** (approach 1 of three that were measured and judged, §2). Rejected: a dedicated preview worker (fails climate edits such as the slider, and master §9 rejects a dedicated map worker) and an incremental configure with 64-px work units everywhere (the most invasive; revisit only if §2's exit evidence fails).
8. **Nest and flatten stay in the spline editor**, for authoring SP3's profiles.

The spec review of 2026-09-30 refined one approved detail: U2's 16 columns are chosen by the lattice conditions under which each leaf acts, with a bounded witness search for threshold leaves (§7), because four columns per water class demonstrably leave threshold leaves such as `lakes.minC` dead.

## Module layout after SP2b

```
src/core/spline/
  edit.ts          insertKnot, deleteKnot, setKnot, nestKnot, flattenKnot, autoTangentsAt (pure, validated)
  weights.ts       pathWeight (moved from test/harness/spline.ts; no `**`)
  validate.ts      + X_OUT_OF_RANGE, D_OUT_OF_RANGE
src/core/params/
  kit.ts           + AMPLITUDE_TINY; amplitude item handling
  schema.ts        spline leaves gain unit 'blocks'
src/engine/
  session.ts       draft model: set, reset, load, gestures, history, subscribe, modified
  workerPool.ts    abort cell, ABORTED, worker errors, epoch-tagged errors, stats jobs
src/gen/map/
  tile.ts          paintTileAbortable (stop callback, optional biome ids); single-sampled shaded preview
  layers.ts        lakes colour clamp
src/gen/column/
  spawn.ts         findSpawnAbortable
src/metrics/
  biomeShares.ts   shares, ties, outside (moved from test/metrics/biomes.metric.ts)
  splineStats.ts   histogram and segment shares of a spline node
  liveness.ts      U2 perturbations, liveness columns, witnesses, stage output hashes
src/workers/
  protocol.ts      + abort cell, ABORTED, BAD_ARGS, error epoch, tile ids, stats job
  taskHandler.ts   stop callback, stats kinds
src/ui/common/     dom.ts (el), base64url.ts, urlWriter.ts (moved from ui/lab), notice.ts, keys.ts
src/ui/map/        mapPage (composition), layout, previewDriver, mapView (fallback tiles, highlight),
                   tileSource, biomeSize, perfHook (dynamic import)
src/ui/paramPanel/ model.ts (pure), controls.ts, panel.ts, lints.ts (pure)
src/ui/splineEditor/ model.ts (pure), plot.ts, tree.ts, drawer.ts, shapeFile.ts (pure)
src/ui/biomeTable/ model.ts (pure), table.ts, shares.ts (cut line)
src/ui/presets/    presetFile.ts (pure), presetsTab.ts
test/tools/mapLatency.ts   the §2.8 exit runner (not in CI)
```

The lab keeps its files and imports the moved helpers from `ui/common`.

## 1. State: the draft, history and URL (`engine/session.ts`)

`WorldSession` stays the single owner of the draft `{seedText, seed, profile, patch, params, epoch}`. Every editor, the slider, the URL and preset loads go through it.

### 1.1 Canonical minimal patch

- The stored patch is always `diffParams(SCHEMA, resolveProfile(profile), params)`, deep-frozen. The session never stores caller input.
- This fixes the −0 crash found in the context review: `applyPatch` accepts `-0` and q15s it to 0, but SP2a stored the raw patch, and `canonicalJSON` throws on −0 in `reconfigure()` and in the URL encoder. With the minimal patch, `canonicalJSON(state.patch)` never throws for a valid state (unit test).
- The epoch rule is unchanged: it increments only when the seed or `paramsHash(params)` changes.

### 1.2 Edits

| method | effect |
|---|---|
| `setSeedText(text)` | SP1 seed rule, as today. |
| `newSeed()` | draws a random seed and writes its text back (the "New seed" button). |
| `setProfile(id)` | ready profiles only; clears the patch; always one undo step. The session never asks for confirmation (§3.1 shows the page's inline confirmation). |
| `set(path, value)` | `path` is a group or a leaf path; on a noise leaf `value` is a partial NoiseDef. Deep-merges `patchAt(path, value)` into the current patch (spline and boxTable leaves and arrays replace; groups and noise leaves merge per key, as `applyPatch` does) and validates over the profile. On failure nothing changes and the issues are returned for the control. |
| `reset(path)` | returns a group or a leaf (a noise leaf as a whole) to the profile's value, by removing it from the patch. |
| `load({seedText?, profile, patch}, {record = true} = {})` | atomic: resolves `seedText` with the SP1 rule when given (otherwise keeps the seed), validates the patch over a ready profile, then replaces seed, profile and patch in one commit: the epoch bumps at most once and subscribers are notified once. Records one history step (§1.3) unless `record` is false. On failure nothing changes and the issues are returned. Preset import and the JSON box omit `seedText`; URL `hashchange` passes the hash's seed. |

- `modified(path)` and `modifiedCount(path)` take a group or a leaf path: whether the draft differs from the profile there, and how many leaves under a group differ.
- Any other path passed to `set`, `reset`, `modified` or `modifiedCount` is a programming error and throws.
- Initialisation follows SP2a §4.3: an unready profile or an invalid patch falls back to `default` and `{}` with a notice (SP2a minor 8).

### 1.3 Gestures, history and notifications

- **Gestures** bracket a drag (slider, knot, tangent handle, interval bar). `beginGesture()` notifies `{kind: 'gestureBegin', urgent: false, gesture: true}`. Edits inside a gesture are non-urgent. `endGesture()` records the gesture's step (if the draft changed) and always notifies `{kind: 'gestureEnd', urgent: true, gesture: false}`, even when the draft did not change. Gestures do not nest: `beginGesture()` while one is active and `endGesture()` without one are no-ops. `undo`, `redo`, `load`, `setProfile`, `setSeedText` and `newSeed` called during a gesture first end it, then run.
- **Drag sources.** Pointer drags use `setPointerCapture` and end their gesture on `pointerup`, `pointercancel` or `lostpointercapture`. A native range slider begins its gesture on `pointerdown` and ends it on `change`. Keyboard steps on a range are ordinary urgent edits. Every edit outside a gesture is urgent.
- **History:** a list of up to 101 snapshots `{seedText, profile, patch}`, so up to 100 steps. A step is recorded when `canonicalJSON` of the new snapshot differs from the snapshot at the history cursor (the patch is minimal, so this never throws); a whole gesture is one step. The snapshot at the cursor therefore always equals the draft. A recorded step after an undo drops the redo tail; an unchanged snapshot records nothing and keeps it. The epoch key (seed, `paramsHash`) only decides whether the epoch changes and the preview reconfigures, never history: a profile switch that keeps the params (default with `scaleMul` 4 → `large_biomes`) and a seed text that resolves to the same seed (`42` → `042`) are recorded steps without an epoch bump.
- `undo()` and `redo()` move the cursor and apply the snapshot as `load(snapshot, {record: false})` does. They are urgent, record nothing and keep the redo tail.
- `subscribe(listener)` returns an unsubscribe function. Listeners receive `(state, change)` with `change = {kind: 'seed'|'profile'|'set'|'reset'|'load'|'undo'|'redo'|'gestureBegin'|'gestureEnd', urgent, gesture}` after every successful change and at gesture boundaries.

### 1.4 URL (`ui/map/mapState.ts`)

- The format is SP2a's: `?map#base64url(canonicalJSON({v: 1, seed, profile, patch, view: {x, z, bpp, layer}}))`, without gzip. The patch is the session's minimal patch, so a full 52-knot offset edit measured 2.3 KB. Master §2.7 is amended to this format (§10).
- **`hashchange`** (SP1 minor 5 for `?map`): decode the hash. If it is invalid, show the SP2a notice and change nothing. Otherwise apply the view with `setView` (never a history step), then call `session.load({seedText: seed, profile, patch})` once (urgent). When the seed and params are unchanged this is a no-op. The raw decoded patch is never passed to `canonicalJSON`, because it may contain −0.
- Panel layout state (§3.1) is not in the URL.

### 1.5 Shared UI code (`ui/common/`)

- `dom.ts`: the `el(tag, className, text)` helper, today duplicated in `mapPage.ts` and `noiseLab.ts`.
- `base64url.ts` and `urlWriter.ts`: moved from `ui/lab/labState.ts` and `ui/lab/urlWriter.ts`, so `?map` no longer imports the lab.
- `notice.ts`: inline notices with optional actions (for example "Undo"), and an inline confirmation (Switch/Cancel) used by the profile switch (§3.1). No `prompt()`, `alert()` or `confirm()` anywhere in `ui/` (an arch test).
- `keys.ts`: the global shortcut handler (§3.5).

## 2. Live preview pipeline

### 2.1 Measured baseline (reference machine D16, headless Chrome, 2026-09-30)

| situation | edit → all visible preview tiles drawn |
|---|---|
| pool idle, biome layer | 84-91 ms median, 135 ms max |
| pool idle, relief layer | 166 ms median, 196 ms max |
| fine tiles in flight (rested CPU) | 420 ms median (configure waits 329-353 ms behind the in-flight tile) |
| fine tiles in flight (sustained load) | 836-852 ms median, up to 949 ms |
| continuous drag at 10-60 edits/s | no preview lands during the drag; the release takes 301-587 ms |

- The map is blank for the whole latency: `reconfigure()` calls `clearSource()`.
- Costs: worker `configure` 0.6 ms (Node) / 1.1-2.6 ms (Chrome); the main-thread `applyPatch` + `paramsHash` of a 52-knot spline edit 0.32 ms; a level-256 preview tile 65-75 ms (biome) and 130-180 ms (relief, rivers, lakes, which sample twice); fine tiles near the origin 0.5-0.85 s.
- `crossOriginIsolated` is true on the dev server and in production, and a SharedArrayBuffer posted to a task worker is shared on both.

The bottleneck is the configure waiting behind in-flight fine tiles; drags never land because each new configure discards the previous cycle's previews.

### 2.2 Cooperative abort (pool, protocol, handler, gen)

- **Abort cell.** `createBrowserPool` creates `abortCell = new Int32Array(new SharedArrayBuffer(4))` when `crossOriginIsolated` is true and `SharedArrayBuffer` exists; `pool.abortable` reports it. `configure` does `epoch++`, `Atomics.store(cell, 0, epoch)`, rejects the queue with `JobCancelled`, then posts `{type: 'configure', epoch, seedText, params, abort}` where `abort` is the SharedArrayBuffer (or null).
- **Worker.** The handler keeps the latest cell and gives each tile, spawn and stats job `stop = () => cell !== null && Atomics.load(cell, 0) !== job.epoch`. An aborted job replies `{type: 'error', jobId, epoch, code: 'ABORTED'}`; the pool resolves it as `JobCancelled`. Point and selftest jobs are not abortable.
- **gen.** `paintTileAbortable(ctx, layer, level, tx, tz, out, stop, ids?)` checks `stop()` once per block row of a preview tile, once per row of an unshaded fine tile and once per row of the sampling pass of a shaded fine tile, and returns null when stopped. `findSpawnAbortable(ctx, stop)` checks once per ring and every 32 candidate points. Stats kinds check every 256 points. `paintTile` and `findSpawn` are wrappers with a `stop` that never fires, so their output, the goldens and `?selftest` do not change. `stop` is a plain callback: `gen` stays free of `Atomics` and worker APIs.
- **Without isolation** (for example a LAN address without COOP/COEP) the pool works as in SP2a, and the page shows the notice "live preview is slower without cross-origin isolation".
- **Barrier.** The all-workers ready barrier and its stage-hash and genKey agreement check stay. With abort, a busy worker answers within one row (≈ 2 ms rested, ≈ 3.5 ms under load).

### 2.3 Worker errors (SP2a minors 3, 4 and 9)

- `ErrorMsg` gains `epoch: number | null`. A job-less error whose epoch is not the pool's current epoch is ignored, so a late error of a superseded configure cannot reject the next one.
- `worker.onerror` and `onmessageerror` reject the pending configure and the failed worker's in-flight job with an `Error`, and the page shows "a worker failed; reload the page".
- The `?selftest` page handles a rejected job as a failed key, so its summary always completes.

### 2.4 Single-sampled shaded preview

- `paintPreview` samples each interior block twice for relief, rivers and lakes (once in the height pass, once for the colour). At level 256, `layerColor` for those layers reads only `surfaceEst` and `surfaceWaterLevel`; every other field it reads is a constant of `sampleCoarse` (no river, no lake).
- The height pass also stores the water level (`HEIGHT` and `WATER_LEVEL` exist), and the colour pass restores both into the record instead of sampling again.
- The output is byte-identical: the `sp2a.tile.relief.256` and `sp2a.tile.rivers.256` goldens guard it, and a unit test compares the lakes layer at 256 against a reference that samples twice. Measured: 109.7 → 55.3 ms per relief preview tile.

### 2.5 Fallback tiles (`ui/map/tileSource.ts`, `mapView.ts`)

- `clearSource()` is removed. `keyFor` still returns a key only for the pool's current epoch.
- The canvas keeps a **fallback key** per visible position `(layer, level, tx, tz)`: the key it last drew there. Where the current source has no cached tile, the canvas draws the fallback tile if it is still cached. Drawing a tile refreshes its LRU entry, so fallbacks stay cached while they are on screen. A fallback is replaced only when a tile of a newer source lands at that position; no count of sources bounds the lookup.
- **Draw order:** fallback tiles (coarse, then fine), then the current source's tiles coarse to fine. A current preview therefore covers a fallback fine tile: the map shows the new draft blurred rather than the old draft sharp.
- The spawn marker stays until the new spawn arrives. The hover readout shows the point of the current epoch only.
- `onPreview(poolEpoch)` fires once per source, in the draw where every visible level-256 position of the shown layer shows a tile of that source.
- **Cache capacity:** `max(256, 3 × (visible target-level tiles + visible preview tiles))`, recomputed on resize (SP2a minor 10, now that fallbacks also occupy the cache). Biome-layer entries hold `{bitmap, ids}` (§5.3).

### 2.6 Preview driver (`ui/map/previewDriver.ts`)

A pure module with injected clock, pool and canvas interfaces. It turns session changes into configure cycles, and it owns the spawn request (in SP2a the page called `pool.spawn()` after `setSource`).

- **Cycles.** A cycle is: configure the pool with the draft, set the canvas source, and wait for `onPreview` of the cycle's pool epoch. Each cycle records two epochs: the session epoch of the draft it configured, and the pool epoch of its configure (`ready.epoch`). At most one cycle is in flight.
- **Non-urgent edits** (inside a gesture) start a cycle when none is running; otherwise they replace the single pending draft ("latest wins"). The pending draft starts when the running cycle's preview lands. There is no timer: finished work is never discarded.
- **Urgent edits** (including `gestureEnd`) abort a running cycle that a gesture started and start at once. A cycle started by an urgent edit is never aborted by another urgent edit: the new draft waits in the slot (this prevents starvation under key-repeat undo).
- **Same epoch.** An urgent edit whose session epoch equals the session epoch of the running or last cycle (for example a `gestureEnd` whose last draft is already shown) does not reconfigure.
- **Interactive plan.** The canvas is interactive (`canvas.setInteractive(true)`: `request()` asks only for level-256 tiles) while a gesture is active or the slot holds a draft. As soon as neither holds it returns to the full plan, even if the running cycle has not landed: preview tiles keep their queue priority, then fine tiles.
- **Settled** means: not interactive, and the latest cycle has landed (or the latest urgent edit had the same epoch). On settling, the driver calls `pool.spawn()` once for that pool epoch if it has no spawn yet (spawn keeps priority −2, so it runs before queued fine tiles), and emits `onSettled`, which the statistics jobs use (§4.3, §5.5).
- **Zoomed out.** When more preview tiles are visible than `pool.size`, a gesture cycle counts as landed once the `pool.size` preview tiles nearest to the centre are drawn; the rest arrive after the gesture.
- **Watchdog.** A cycle that has not landed after `max(1000 ms, 3 × EWMA of recent cycle times)` counts as landed, and the pending draft starts.
- **Status.** The toolbar shows "last edit → preview N ms" (input time to `onPreview`) and the pending state.
- **Effect.** During a drag nothing but preview tiles is ever in flight, so each configure is answered in about 2 ms even without the abort cell, and the heat that slows tiles 1.7× under sustained load is avoided.

### 2.7 View changes

- Pan and zoom never reconfigure: they call `setView`, and `request()` plans tiles for the current source under the current plan (interactive or full). Positions newly exposed by a pan or zoom have no fallback until their first tile lands.
- A layer switch draws the new layer's tiles; fallbacks are per layer.

### 2.8 Exit definition and measurement

- **Latency** = `drawnAt − inputAt`: from the input event's `timeStamp` (or `performance.now()` at a hook call) to the end of the animation-frame draw in which every visible level-256 position shows a tile of the edit's source or of a newer one.
- **Blank draw:** after the page's first image, a draw in which a visible level-256 position of the shown layer that showed a tile (current or fallback) in the previous draw of that layer shows none.
- **Hook:** `?map&perf=edit` loads `ui/map/perfHook.ts` by dynamic import. It pins the map canvas to 1100×825 CSS px at DPR 1 with seed 42, the default profile, view (0, 0, 64 bpp) and the layer from the URL state: 4 preview tiles and 24 level-64 tiles, as in the baseline. It exposes:
  - `__wiPerf.set(path, value)`, `beginGesture()` and `endGesture()`, which call the session exactly as the editors do (urgency follows §1.3);
  - `__wiPerf.setWhenBusy(path, value)`: reads the pool probe and, in the same task, calls `set` if at least one level-64 job is in flight; otherwise it returns false and the runner retries after the next animation frame;
  - the latency records with their breakdown (input → configure posted → all ready → preview jobs done → drawn), the blank-draw counter and the pool probe (busy workers and the level of each in-flight job).
- **Edits:** `shape.offset` knot `[6, 0, 1]` via `withKnotY`, with a y value never used before in the run (alternating two values would hit the tile cache).
- **Conditions:**
  - A, idle: pool empty, CPU rested 2 s; 20 edits per gated layer per page load;
  - B, busy: `setWhenBusy` after the full plan has resumed; 20 edits per gated layer per page load;
  - C, sustained: 30 edits, each 100 ms after the previous preview;
  - D, drag: `beginGesture()`, 3 s of `set` calls at 30 Hz and at 60 Hz, then `endGesture()` as the release (no new value); the release latency runs from `endGesture`'s `performance.now()` to the draw that shows the last draft's source or a newer one; 5 repetitions per rate.
- **Layers:** gated: biome and relief under the offset edit, in A-D. Reported, not gated: the offset layer under the same edit, and biome-size slider steps (`climate.scaleMul` table values) on the biome and relief layers, each in A-D.
- **Pass** (D16, Chrome stable, 3 page loads per gated layer): max ≤ 300 ms in A, B and C and for every release in D; in D at least one preview lands per 500 ms during the drag; blank draws = 0 everywhere. Report p50, p95 and max per condition.
- **Runner:** `test/tools/mapLatency.ts` (Node 24 type stripping, CDP over the global WebSocket). It runs `npm run build`, then `vite preview --host 127.0.0.1 --port <P> --strictPort`, where `<P>` is a free port it picks by binding port 0 and releasing it (never 5183, which the dev server and its container use; the COOP/COEP headers come from `preview.headers`). It treats the server as ready only when its own child process prints its URL, fails if that child exits or the port is taken, and never falls back to a server it did not start. It launches its own headless Chrome with a temporary profile, asserts `crossOriginIsolated` and `pool.abortable`, loads one page per gated layer (layer in the URL state) and never switches layers or moves the view during a run. At the end it stops only the processes it started. JSON results go to `docs/superpowers/specs/assets/sp2b/latency-*.json`.
- **Also recorded, not gated:** one run against production after the merge, and a Firefox check by the user (the status line after a few edits and a drag).

### 2.9 Deferred levers (not needed for the exit)

- A climate-grid cache per worker (a preview tile painted from a stored climate grid costs ≈ 6 ms instead of ≈ 54 ms): the lever if the 7-14 Hz drag cadence feels choppy, and for SP4's one-MAP-job cap.
- A preview key for rivers and lakes edits (their preview is identical, yet the shape hash changes), preview sub-tiles, and an intermediate level when zoomed in to 16 blocks/px or closer.

## 3. Page layout and parameter panel

### 3.1 Layout (`ui/map/layout.ts`, `map.css`)

- A CSS grid: toolbar row; main row with the map and the side panel; the drawer row under both. A draggable splitter sets the side panel width (280-520 px) and another the drawer height (160 px to 60 % of the viewport). The drawer is closed until a spline is opened. The map canvas follows its host through the existing `ResizeObserver`.
- Below 900 px of viewport width the side panel stacks under the map.
- Panel width, drawer height, active tab and open sections persist in localStorage under `wi10.layout.v1` behind try/catch (master §2.7 allows "panel layout"); a missing or invalid value gives the defaults.
- **Toolbar:** layer select; seed input with "Same seed" (commits the typed text, as Enter does) and "New seed"; profile select (ready profiles); the biome-size slider (§6.4); undo and redo; grid toggle; the preview status (§2.6).
- **Profile switch:** when the patch is non-empty, choosing a profile first shows an inline confirmation "Switching to PROFILE clears N modified parameters" with Switch and Cancel (replaces `confirm()` at `mapPage.ts:130`). Cancel restores the select; Switch calls `setProfile` and shows the notice "profile switched" with Undo.
- **Tabs:** World (session status, hover readout, spawn, notices), Parameters (§3.2), Biomes (§5), Presets (§3.4).

### 3.2 Parameter panel (`ui/paramPanel/`)

- `model.ts` (pure) builds the panel tree from `SCHEMA.nodes` in schema order: each group is a section, each leaf a control spec `{path, kind, label, doc, unit, min, max, step, scale, scope}`.
- **Sections** are collapsed by default. The header shows the label, "n modified" and a section reset.
- **Controls by kind:**
  - `number` / `int`: a slider plus a numeric field. The slider is logarithmic when `min > 0` and `max / min ≥ 20` (for example `scaleMul`), linear otherwise; `step` is a UI hint and never snaps a typed value.
  - `noise`: a sub-block with wavelength (logarithmic over the leaf's wavelength range), octaves, persistence, lacunarity, amplitudes, `clampSigma`, `double` and `remap`, written with `session.set(<noise leaf>, partialNoiseDef)`. Fields a rule fixes are disabled with the reason in the tooltip (`yScale` is 1 for 2D noises; `remap: 'uniform'` needs `double` and 2D).
    - Amplitudes is a two-state toggle: `null` (the persistence weighting) or an explicit per-octave list. Switching to a list writes `q15(persistence^i)` for i < octaves, with any item below 1e-6 written as 0 (so `AMPLITUDE_TINY` cannot refuse the toggle); switching back writes `null`.
    - While a list is active, an octaves change writes `{octaves: n, amplitudes: resized}` in one call: the list is truncated, or extended with 0 for each added octave.
    - The sub-block has one modified dot and one reset for the whole noise leaf; its fields have no reset of their own.
  - `spline`: an "Edit" button that opens the drawer on the leaf, plus the leaf's modified dot and reset.
  - `boxTable`: a link to the Biomes tab.
- **On every control:** a scope badge (Climate: "recomputes everything"; Terrain: "recomputes shape and biomes, keeps raw climate"; the Live, Remesh and Decorate badges exist in the model for later leaves), a modified dot against the profile, a reset button, and a tooltip with the doc, range, unit and path.
- **Input:** slider drags are gestures (§1.3); a numeric field commits on Enter or blur (urgent) and Escape restores the draft value. An invalid value shows a red border and the issue text under the control; it is not applied.
- **Cross-field lints** (`lints.ts`, pure) are warnings, not validation: `rivers.coastFadeLo < rivers.coastFadeHi`, `rivers.altFadeLo < rivers.altFadeHi`, `lakes.offsetMin < lakes.offsetMax`. The runtime already tolerates the inverted cases (a step instead of a fade, no lakes).
- Every leaf of today's schema has stage climate, shape or biome2d, so the panel shows only Climate and Terrain badges, and every leaf is covered by U2 (§7).

### 3.3 World tab

- Session status (seed, profile, epoch, workers, view), the hover readout (as today), the spawn, and notices.

### 3.4 Presets tab (`ui/presets/`)

- **Export:** an inline name field. The name is trimmed and must be 1-64 UTF-16 units and not a profile id (the reason is shown inline). `exportPreset(name, profile, params)` is downloaded as `<file name>.wi10-preset.json`, where the file name keeps `[A-Za-z0-9 _.-]`, replaces other characters with `_` and is at most 64 characters.
- **Import:** a file input attached to the DOM, read with `FileReader` (with `onerror`). JSON parse errors and every `importPreset` issue are listed with their path. A preset whose profile is not ready yet gets "profile `archipelago` arrives in SP3" (from `readyFrom`). On success `session.load({profile, patch: diffParams(SCHEMA, resolveProfile(profile), params)})`, one undo step, and the notice "loaded preset NAME".
- **Advanced:** the JSON patch box, showing `canonicalJSON` of the minimal patch; applying it replaces the patch (`session.load({profile, patch})`).
- The pure part (`presetFile.ts`: name checks, file names, parse and import to `{profile, patch}` or issues) is unit-tested.

### 3.5 Keys (`ui/common/keys.ts`)

- P shows or hides the side panel; Ctrl/Cmd+Z undoes; Ctrl/Cmd+Shift+Z and Ctrl+Y redo; Escape closes the drawer unless a text-entry control handles it first (§3.2).
- Undo and redo are ignored only in a text-entry control, where the browser's own text undo applies: a `textarea`, a `contentEditable` element, or an `input` of type text, search, number, url, email or password. Range, checkbox, radio, button and file inputs and `select` do not block them, so dragging a slider and then pressing Ctrl+Z undoes the drag. P is also ignored in a `select` (type-ahead).

## 4. Spline editor (`ui/splineEditor/`, `core/spline/edit.ts`)

### 4.1 Pure edit operations (`core/spline/edit.ts`)

Each operation takes a spline and a `KnotPath` (SP1 addressing: `[7, 1, 1]` is `points[7].y.points[1].y.points[1]`) and returns `Result<NestedSpline>` validated with the leaf's `SplineOpts` (coords, `yMin`, `yMax`) and §6.1's bounds.

| operation | effect |
|---|---|
| `setKnot(s, path, {x?, y?, d?})` | sets a knot's x, numeric y or tangent; neighbours are untouched. |
| `insertKnot(s, nodePath, x, y)` | inserts a numeric knot into the node at `nodePath`; its tangent comes from SP1's `autoTangents` rule applied to that knot only. A duplicate x is refused (`X_DUPLICATE`). |
| `deleteKnot(s, path)` | removes a knot; a node cannot lose its last knot (`EMPTY`). |
| `nestKnot(s, path, coord)` | turns a numeric knot into a child spline over `coord` with two flat knots `{x: −1, y, d: 0}` and `{x: 1, y, d: 0}` (the value is unchanged everywhere). `coord` must be in the leaf's coords and unused on the path. |
| `flattenKnot(s, path, probe)` | replaces a child spline with its value at the probe coords. |
| `autoTangentsAt(s, nodePath)` | recomputes the tangents of that node's knots (not recursive) with the SP1 rule. `autoTangents(s)` (SP1) does the whole spline. |

`pathWeight` (the Hermite value-basis weight of a knot along a path, used by T6) moves from `test/harness/spline.ts` to `core/spline/weights.ts`, rewritten without `**`; T6 and the editor's statistics use it from there.

### 4.2 Drawer

- **Header:** the leaf label and breadcrumbs from the typed coords (`offset › C=0.30 › E=−0.4`); clicking a crumb goes up. **Probe** sliders set the coords the plot does not show (default 0). Buttons: auto tangents (node, spline), reset spline (to the profile), export and import shape, close.
- **Tree** on the left: every node with its coord and knot count (`C=0.30 → E (4 knots)`); clicking a node opens it.
- **Plot (SVG):**
  - x axis: the node's coord from `NestedSpline.coord`, over `[min(−1, x_first), max(1, x_last)]` so every knot is visible, with the hold regions beyond the end knots shaded and marks at ±L(coord), the coord's reachable range computed from the draft: `L = uMax(params.climate.<coord>.clampSigma)` for C, E, W, T and H (0.9973 at the default clamp of 3), and `L = 1` for PV, which the fold spans fully for every legal clamp (no marks). `model.ts` exports `reachLimit(coord, params)` for the marks and the lint;
  - y axis in blocks, over the leaf's range (the three spline leaves gain `unit: 'blocks'`); for offset, a line at sea level 63;
  - the curve is the generator's evaluation of the node with the other coords at the probe values; knots whose y is a child spline are drawn hollow at their evaluated value, and double-clicking one opens it.
- **Interaction** (the 08/09 SVG skeleton, master §1 deliberate port, rewritten against tests):
  - dragging a knot moves x between its neighbours (at least 2⁻¹⁰ apart; end knots within [−2, 2], §6.1) and y within the leaf range;
  - a tangent handle sets d;
  - a numeric panel edits the selected knot's x, y and d;
  - double-clicking empty plot space inserts a knot on the curve; Delete removes the selected knot; a context menu offers nest by coord and flatten;
  - clicking a lint entry selects its knot and opens its node;
  - drags are gestures (§1.3), so one drag is one undo step.
- `model.ts` (pure, unit-tested): plot transforms, hit testing, clamping, breadcrumb labels, probe vectors, `reachLimit`.

### 4.3 Overlays and lints

- **Statistics job** `splineStats` (§5.4): over a fixed stream of N = 60 000 points (`samplePoints('sp2b.splineStats', 60000)` in the colKey window) with the current seed and params, split across the pool. Each point i gets the weight `w_i = pathWeight` down to the open node (1 for the root).
  - A 64-bin histogram of the node's coordinate, binning the weights `w_i`.
  - Per segment `[x_k, x_{k+1})`, plus the two hold regions: `landShare_k = Σ_{i∈k, offset0_i ≥ 63} w_i / N_land` and `worldShare_k = Σ_{i∈k} w_i / N`, where `N_land` is the unweighted number of land points, so "this segment covers 7.3 % of land and 4.1 % of the world". A node's land shares sum to its mean weight over land points, and its world shares to its mean weight over all points.
  - Requested when the preview driver settles (§2.6), and when a node opens while it is settled, so a request always runs on the draft the pool holds. Shown as stale from the next session change until the result arrives.
- **Histogram shape.** Under CDF-uniform climate the histogram of C, E, W, T or H is flat; PV is not (it is folded from W), and nested nodes are conditional on their bracket. Master §5.3's "flat by construction" is amended (§10).
- **Lints:**
  - a knot is unreachable when its influence interval `(x_{k−1}, x_{k+1})` misses `[−L, L]` of its coord (§4.2); an end knot's interval is unbounded on its outer side, so an end knot is flagged only when its inner neighbour is also beyond L on the same side; a node's only knot is never flagged. The default splines and `nestKnot`'s ±1 knots produce no such lint (unit test). The lint recomputes when a `clampSigma` changes;
  - a curve that leaves the leaf's y range between knots (checked at 512 points of the node) is a warning with the largest overshoot. The validator checks y only at knots.

### 4.4 Shape files (`shapeFile.ts`)

- Export writes `{format: 'wi10-shape', leaf, spline}` for the open leaf (`leaf` is `shape.offset`, `shape.sigma` or `shape.jag`).
- Import validates the spline against the **open** leaf's coords and range and replaces the leaf (one undo step). `leaf` is optional on import: a file without it (the master's original format) is validated with no notice; a file whose `leaf` names another leaf is accepted if it validates, with a notice. Errors are listed with their path.

### 4.5 Cross-section (cut line → SP10)

- A line tool on the map (two clicks) and a second drawer tab showing, along the line, offset0, offset ± σ, jag, river channels and gorges, lake levels and sea level, from a `crossSection` stats job over 512 points with `samplePoint`.

## 5. Biome table, highlight and statistics jobs

### 5.1 The table as it is (master §3.10 and §5.4 amended, §10)

- Rows: the 26 box biomes of `BOX_BIOMES`; river and frozen river come from the river flag; the height filter keeps ocean boxes below sea level and the other boxes above it (SP2a §3.2); cave biomes arrive in SP6.
- Columns: `[lo, hi]` on C, E, PV, T and H within [−1, 1]; `wSign` (−1, 0, +1); a unique priority (1-1000). No weights: the picker's fitness is the unweighted sum of squared overshoots.

### 5.2 Biomes tab (`ui/biomeTable/`)

- One row per box: colour swatch, name, family badge, five compact `[lo, hi]` fields with a bar over [−1, 1] (the bar's ends are draggable, as gestures), a `wSign` select and the priority field.
- Every change writes the whole table with `session.set('biomes.table', table)` (the leaf is atomic). The edited cell shows its issue:
  - `model.ts` checks a typed priority against the other 25 rows before calling `set` and refuses a duplicate with `DUPLICATE_PRIORITY` on the edited row and the message "priority N is also used by ROW", whatever the order, sort or filter;
  - a typed `[lo, hi]` with lo ≥ hi shows `BAD_INTERVAL` on that axis cell;
  - bar-end drags clamp lo to `[−1, hi − 2⁻¹⁰]` and hi to `[lo + 2⁻¹⁰, 1]`, so a drag never produces `BAD_INTERVAL`.
- Reset per row (to the profile's row) and for the table; sort by priority, name or family; filter by family.
- `model.ts` (pure, unit-tested): rows, interval, sign and priority edits returning a new table, the priority check, interval clamping, row reset, sorting and filtering.

### 5.3 Row highlight on the map

- Biome-layer tiles also carry the biome id of every pixel: `paintTileAbortable` fills an optional `ids: Uint8Array(65536)` (preview tiles: the 2×2 block's sample), and `TileMsg` gains `ids?: ArrayBuffer` (transferred) for layer `biome` only. The tile goldens hash only RGBA, so they do not change.
- Hovering a row makes the canvas draw, over each visible biome tile, a mask that dims every other biome (about 0.2 ms per tile).
- **Memory.** Ids cost 64 KB per cached biome tile: 16 MB at the minimum capacity of 256 (§2.5), growing with the viewport-sized cache like the bitmaps, which are 4× larger. The mask cache holds masks for the hovered biome only, keyed by tile key; it is cleared when the hovered row changes, when the hover ends or when the source changes, and an entry is dropped when its tile leaves the tile cache.
- On other layers the row hover shows the notice "switch to the biome layer to highlight".

### 5.4 The `stats` job

- **Protocol:** `{type: 'stats', jobId, epoch, kind, from, to, args}` → `{type: 'statsResult', jobId, epoch, kind, data}`. `data` is an ArrayBuffer (transferred) holding a Float64Array of raw, unnormalised weighted counts. Each kind's module in `src/metrics/` defines the layout and exports its length (for example `splineStatsLength(knotCount)`: 64 histogram bins, then the land and all totals per segment and hold region, then the total weight; `biomeSharesLength()`: one count per biome id, then ties, outside and the total). The caller passes that length in `args.len`, so `parseFromWorker` checks `byteLength === 8 × len` without importing metrics.
- **Splitting:** for `splineStats` and `biomeShares` the pool splits the point range into `pool.size` slices, runs them as ordinary queued jobs and adds the slice arrays element-wise without knowing the kind (`engine/` may import `metrics` only as types). The UI caller turns the sum into shares with the kind's summarising function. `crossSection` runs as one job.
- **Scheduling:** stats slices run at priority 500 (after preview tiles, before fine tiles at 1000 + distance; spawn −2 and point −1 keep theirs). A slice that rejects with `JobCancelled` drops the whole request without retry; the next `onSettled` sends a fresh one.
- **Arguments:** for `splineStats`, `args = {len, leaf: 'shape.offset' | 'shape.sigma' | 'shape.jag', node: KnotPath}`. If the node does not exist in the configured spline, the worker replies `error BAD_ARGS` and the overlay stays stale.
- The computations live in `src/metrics/` so that tests call the same functions. Like `sp2aGoldens.ts` they follow the determinism rules: `DET_FILES` in `test/arch/rules/banned.ts` gains `metrics/splineStats.ts`, `metrics/biomeShares.ts` and `metrics/liveness.ts`.

### 5.5 Biome share preview (cut line → SP10)

- `biomeShares` over `samplePoints('sp2b.biomeShares', 100000)` with the current seed and params, using `columnPoint` (rivers and lakes included): counts per biome, ties and "outside every box". Estimated 270 ms on 6 workers. Requested on `onSettled`.
- A bar chart per biome, marked stale from the next session change until the result arrives, with B1-style warnings: unreachable (< 0.1 %), dominant (> 16 % for a land biome), ocean family outside 25-45 %, ties, and outside > 2 %.
- `src/metrics/biomeShares.ts` holds the counting and summarising that B1 uses today; `test/metrics/biomes.metric.ts` calls it. The move is checked by running B1 on every tier before and after it: the values must be identical.

## 6. Validation fixes and the biome-size slider

### 6.1 Spline bounds (SP1 minor 2)

- `validateSpline` gains `X_OUT_OF_RANGE` (|x| > 2) and `D_OUT_OF_RANGE` (|d| > 1e5 blocks per unit of the coord). SP1 §3.2's "|x| > 1 is legal" becomes "legal up to 2". Knots beyond ±1 never occur in the climate, and the editor lints unreachable knots by the §4.3 rule.
- With knot y inside the leaf range, these bounds guarantee finite evaluations. The contract "no issues ⇒ `compileSpline` succeeds" becomes "no issues ⇒ finite outputs everywhere", property-tested over random valid nested splines.

### 6.2 Tiny amplitudes (SP1 minors 1 and 3)

- `checkNoise` gains `AMPLITUDE_TINY`: every non-zero amplitude must have |a| ≥ 1e-6 (0 still silences an octave), so the squared sum can no longer underflow to 0 and turn samples into ±clamp or NaN.
- An amplitude item that is not a finite number gets its own issue and is not counted as 0, so it no longer adds a spurious `AMPLITUDES_ZERO`.

### 6.3 Effect and other minors

- Every default and profile satisfies §6.1-6.2: no golden changes, no `GENERATOR_VERSION` bump, no `SCHEMA_VERSION` bump (a tightening with no real presets affected). New codes join `IssueCode`.
- `test/harness/params.ts` (random valid params) now also varies spline x and d, amplitudes and box tables, closing the gap that let SP2a's "random valid params keep every field finite" test miss SP1 minors 1 and 2.
- SP2a minor 7: the lakes-layer colour clamps `(Lw − 63) / 137` to [0, 1] (no golden tile uses the lakes layer).
- SP2a minors 1 and 2: the world window is half-open, `[−2^19, 2^19)`, in both the protocol's tile and point bounds and the page's hover check. Hovering outside it shows "outside the world window" and sends no point job.

### 6.4 Biome-size slider (`ui/map/biomeSize.ts`)

- Ten integer positions. Position v writes `climate.scaleMul = BIOME_SIZE_SCALE[v − 1]`, a literal table of q15 values of `4^((v − 5)/5)`:
  `[0.329876977693224, 0.435275281648062, 0.574349177498517, 0.757858283255199, 1, 1.31950791077289, 1.74110112659225, 2.29739670999407, 3.0314331330208, 4]`.
  A unit test checks the table against the formula; the literal table keeps the written value independent of each engine's `Math.pow`.
- The position is derived from the draft: `v = clamp(Math.round(5 + 2.5 · Math.log2(scaleMul)), 1, 10)`, nearest in log space (`Math.round` rounds .5 up, so `scaleMul` 2 gives exactly 7.5 → 8). When `scaleMul ≠ BIOME_SIZE_SCALE[v − 1]` (typed in the panel or loaded from a preset), the slider shows a "≈" mark and the exact value in its tooltip; moving it overwrites the value.
- `scaleMul` is climate scope, so every step recomputes all layers: dragging is a gesture (preview only), the release is urgent.
- The `large_biomes` profile (`scaleMul` 4) shows position 10. The default profile at position 10 gives the same params under a different profile id; both stay valid.

## 7. U2: parameter liveness (`src/metrics/liveness.ts`)

Master §6.4: "±15 % on each non-live param changes its stage output hash in ≥ 1 of 16 columns — 100 %". SP2b gates it for every column-scope leaf, which today is every leaf (stages climate, shape and biome2d).

- **Perturbations per kind** (each clamped to the leaf's validity; a leaf is live if either direction changes the hash):
  - `number` / `int`: v ± 15 % of |v|; when v is 0 or that step leaves the range, ± 15 % of the range span (at least 1 for `int`);
  - `noise`: wavelength ± 15 %, within the leaf's wavelength range;
  - `spline`: all numeric knots together, each moved by ± 15 % of the leaf's y span and clamped to [yMin, yMax];
  - `boxTable`: every interval shrunk by 15 % of its width towards its centre, and grown by 15 % (clamped to [−1, 1]).
- **Stage output hash** of a column, from the stage's own outputs on its ColumnSample (seed 42, default profile):
  - climate: C, E, W, T, H, R and PV at the 49 lattice points;
  - shape: offset0, sigma0, jag0, offset, sigma, jag, riverDist, riverStrength, the river flags, lakeMask, lakeLevel, lakeFloor, surfaceWaterLevel and surfaceEst;
  - biome2d: the biome ids at the lattice points plus the per-block zoomed biomes of the column (`readBiome`), which is where `biomes.zoomJitter` acts.
- **Class columns** (`livenessColumns`): 16 columns, each chosen by the lattice condition under which its leaves act, scanning `samplePoints('sp2b.liveness', 200000)` with seed 42 and the default params:
  - 2 land columns with no water within 64 blocks;
  - 2 coast columns (|offset0 − 63| ≤ 8);
  - 2 channel columns: a lattice point with riverDist < width/2, riverStrength > 0 and offset0 in [63, altFadeLo); one of them also has a land lattice point with riverDist in [width/2 + 0.85·wetMargin, width/2 + 1.15·wetMargin);
  - 2 gorge columns: a lattice point with riverDist < width/2 and altFadeLo < offset0 < altFadeHi (strict);
  - 2 basin columns (a lattice point with lakeMask = 1);
  - 2 rim columns: a lattice point with 0 < lakeMask < 1 whose offset before the lake step is below Lw + 0.85·rimRise + 3·rimSigma (the downhill side of the rim, where `rimRise` acts);
  - 4 threshold columns, one each for `lakes.p`, `lakes.minC`, `lakes.offsetMin` and `lakes.offsetMax`: a lattice point with lakeMask > 0 whose nearest cell's probe (from the exported `lakeCell` and `cellEligible`) lies in a band one of the leaf's perturbations crosses (roll ∈ [0.85·p, p); C ∈ (minC, minC + 0.15·|minC|]; offset0 ∈ [offsetMin, offsetMin + 0.15·|offsetMin|); offset0 ∈ (offsetMax − 0.15·|offsetMax|, offsetMax]); when that band is empty within the scan, the loosening band stands in (for example offset0 ∈ (offsetMax, 1.15·offsetMax] with every other eligibility test true).
  - A unit test asserts that every class fills within the scan and names any empty class. The stream id is never changed to make U2 pass; if a class is empty, the scan length changes.
- **Witnesses.** A leaf whose perturbations change no hash on the 16 class columns is retested on witnesses: lake-gate leaves on the first lake cell, in a fixed spiral from (0, 0) up to 16 384 cells, whose `cellEligible` differs between the base and perturbed params (its centre column is the witness); every other leaf on the next columns of the stream, up to 2048, until a hash changes. A leaf is live if a class column or its witness changes the hash.
- **Metric** `U2.value` = live leaves / column-scope leaves, threshold min 1 (`activeFrom: 'SP2b'`), the same on every tier. The metric output names each leaf's deciding column (class or witness); a failure names each dead leaf and the class meant to exercise it. Budget: under 1 s for the class columns, under 2 s for witnesses.

## 8. Tests

- **Unit:**
  - session: `set` (group, leaf, noise partial), `reset`, `load` with and without `seedText`, minimal patch, −0 input, `modified`, the SP2a minor 8 fallback, subscriptions;
  - history: 100 steps and the redo tail; default + `scaleMul` 4 → `large_biomes` → undo restores (default, `{climate: {scaleMul: 4}}`) with no epoch bump; `42` → `042` is one step without an epoch bump; undo and redo across a seed change restore `seedText`; a gesture that ends where it began records nothing; `endGesture` notifies an urgent `gestureEnd` when the draft is unchanged; undo during a gesture closes it first;
  - URL: `hashchange` with a new seed and patch gives one epoch bump, one notification and one step; a view-only change is not a step;
  - keys: the target predicate (range or select focused → Ctrl+Z handled; text or number input focused → ignored);
  - preview driver with a fake clock and fake pool and canvas, whose pool epochs differ from the session's (for example starting at −1 and skipping): never two cycles in flight; no preview discarded by a gesture draft; urgent edits abort only gesture cycles; a same-epoch `gestureEnd` switches to the full plan without reconfiguring; interactive exactly while a gesture is active or the slot holds a draft; spawn requested once per settled epoch; the zoomed-out rule; the watchdog; a 60 Hz drag lands one preview per cycle;
  - fallback tiles: the last drawn key is used while cached and replaced only by a newer source; a zoomed-out view with 9 preview positions, `pool.size` 6 and 10 gesture cycles has no blank position;
  - pool (fake workers): a job-less error of a superseded epoch is ignored and the next configure resolves; `onerror` and `onmessageerror` reject the pending configure and that worker's in-flight job; `ABORTED` resolves as `JobCancelled`; aborting a stats request rejects it and drops its partial sums;
  - gen: `findSpawnAbortable` returns null when stopped and equals `findSpawn` otherwise; biome ids equal the biome of each pixel's sample point (preview: the 2×2 block's sample); the single-sampled preview equals the double-sampling reference for relief, rivers and lakes at level 256; the lakes colour is clamped at Lw 50, 63, 200 and 300;
  - hover and protocol: the half-open window `[−2^19, 2^19)`; a point outside it sends no job;
  - tile cache: capacity = `max(256, 3 × (visible target-level + visible preview tiles))`, recomputed on resize;
  - spline edit operations (every issue path), `pathWeight` (moved) with T6 unchanged, editor model transforms, clamping and `reachLimit`, the unreachable-knot lint (no lint on the defaults or `nestKnot` output), shape files (with and without `leaf`);
  - panel model: tree from the schema, log-slider mapping, the amplitudes toggle and octave resizing, lints, badges; preset names and file names; presets tab logic (export = `exportPreset(name, session profile, session params)`, import = one `load` and one step); biome table model (priority check, interval clamping); the biome-size table and position mapping (each table value maps to itself without "≈"; 2 → 8, 2.01 → 8, 0.25 → 1, 16 → 10 with "≈");
  - `splineStats` and `biomeShares` against a direct computation; pool-split results equal a single-slice run exactly for `biomeShares` counts and for `splineStats` at the root node, and within 1e-10 relative for weighted sums of nested nodes;
  - §6.1-6.2 bounds, with property tests: no issues ⇒ finite outputs;
  - U2's class scan fills every class; the witness search finds `lakes.minC`;
  - an arch rule: no `prompt(`, `alert(` or `confirm(` under `src/ui`.
- **Integration** (`worker_threads`, project `unit`): with an abort cell, a level-4 relief tile stops within 50 ms of `Atomics.store` and replies `ABORTED`; the next tile is byte-identical to a fresh worker's.
- **Metrics:** U2 (§7) on every tier.
- **Bench:** new rows `worker.configure`, `map.tile.b256.biome` and `map.tile.b256.relief`, recorded with `npm run bench:record` on D16 and gated at +30 %.
- **Tools (not in CI):** the latency runner (§2.8) and a CDP smoke script for the UI: edit a number, drag a knot, drag the slider, edit a box, switch profile with a modified draft (confirm, then Undo), import and export a preset, undo and redo, reload and restore; no console errors.

## 9. Governance steps

- The first commit appends `'SP2b'` to `STARTED_SPS`, sets `CURRENT_SP = 'SP2b'` (no profile becomes ready: none has `readyFrom 'SP2b'`), accepts the thresholds lock and appends to the Threshold log below.
- The U2 row joins `test/thresholds.ts` with its own lock accept and Threshold-log line.
- The spline leaves' `unit` changes the README reference: `npm run docs:params`. The schema-shape lock records only leaf kinds, so it does not change.
- `DET_FILES` in `test/arch/rules/banned.ts` gains the three new metrics files (§5.4).
- No golden may change. Every generator-side change in SP2b is byte-identical (§2.2, §2.4); an unexpected golden change is a bug, not a re-record.
- D20 at exit: `?selftest=1` 47/47 in Chrome and Firefox, and Bun 47/47.

## 10. Master-spec amendments made with this spec

- **§2.7:** the world URL is `?map#base64url(canonicalJSON({v: 1, seed, profile, patch, view}))` with the minimal patch, without gzip (it replaces `#seed=…&profile=…&p=base64url(gzip(diff))`).
- **§2 (rule scopes, line 162):** the determinism rules also cover the SP2b metrics files (`metrics/splineStats.ts`, `metrics/biomeShares.ts`, `metrics/liveness.ts`).
- **§3.10:** fitness is the unweighted sum of squared overshoots with ties broken by `priority`; the table has no weights.
- **§4.3:** SP2b implements the epoch cell as one pool-wide cell for map, spawn and stats jobs; SP4 widens it to per-scope cells.
- **§5.1:** until SP4 the map previews the draft and there is no Apply; the session's gestures and urgency are the hooks SP4's Apply and SP5's fork dialog attach to.
- **§5.3:** tangents are data with explicit auto actions; undo and redo are global over the draft (100 steps) instead of 50 steps per spline; the coordinate histogram is flat only for C, E, W, T and H; nest and flatten are editor operations; shape files are `{format: 'wi10-shape', leaf, spline}` (§4.4).
- **§5.4:** the table has 5 axes, `wSign` and priority, no weights; 26 box rows plus the two flag biomes, narrowed by the height filter; cave biomes arrive in SP6; the share preview samples on the pool (≈ 270 ms for 100k points on 6 workers).
- **§5.6:** the tile cache holds `max(256, 3 × (visible target-level tiles + visible preview tiles))` entries, recomputed on resize; biome-layer entries hold `{bitmap, ids}`.
- **§6.4:** U2's perturbations per kind, stage output hashes, class columns and witnesses (§7).
- **§7:** "map preview after a spline edit ≤ 300 ms coarse" means every visible level-256 tile of the draft drawn, measured as in §2.8.
- **§10 SP2b:** add "Received from SP2a: the raw W/T/H/R layers and the grid overlay exist; the spawn fallback refinement is closed as not needed (N4 spawnOnLand is 100 % over 64 seeds with the SP2a fallback)", and remove it from the default cut-line receivers. SP3 receives SP2a minors 5 and 6, SP10 the lab minors (Appendix A).
- **SP1 §3.2 and §4.2:** knots are legal up to |x| ≤ 2 and tangents up to |d| ≤ 1e5; `IssueCode` gains `X_OUT_OF_RANGE`, `D_OUT_OF_RANGE` and `AMPLITUDE_TINY`.

## 11. Notes handed to later SPs

- **SP3:** the editor's nest and flatten author the draft profiles' splines; amplified's post-multiplier (SP1 §10) should be baked into spline data, so the editor's y axis stays the terrain; the height filter's move to `surfaceEst` (SP2a §10) also moves the editor's land share and U2's classes to the new surface; SP2a minors 5 and 6 (Appendix A).
- **SP4:** mount the panel, drawer and table in the game; add Apply on top of the session's urgent commits; widen the epoch cell per scope; with the one-MAP-job cap, consider the climate-grid cache (§2.9).
- **SP5:** a named preset library in IndexedDB `presets`; the fork dialog on the first Apply.
- **SP10:** the cut-line items if they slip; the lab minors (Appendix A); the metrics dashboard reuses `src/metrics/biomeShares.ts`.

## 12. Exit criteria

| criterion | checked by |
|---|---|
| build, tests and full metrics with U2 active | `npm run build && npm test && npm run test:metrics:full` |
| CI green | GitHub Actions |
| edit → preview ≤ 300 ms, no blank draws, drags land previews | `test/tools/mapLatency.ts` on D16, JSON in Exit evidence (§2.8) |
| abort ≤ 50 ms and byte-identical tiles after abort | integration test |
| U2 = 100 % | metric U2 |
| preset tests | the §8 session, presets and preset-name unit tests |
| every Appendix A item marked "SP2b" fixed | the §8 unit tests named there |
| goldens unchanged; `?selftest=1` 47/47 in Chrome and Firefox; Bun 47/47 | goldens tests, browsers, Bun tool |
| bench within +30 % with the new rows | `npm run bench` |
| visual review | screenshots: panel, drawer with overlays, biome table with a highlighted row, presets tab, the map during a drag |

**Cut line:** the biome share preview (§5.5) and the cross-section (§4.5) → SP10.

## Appendix A — Review minors received

Sources: the SP1 final review (2026-09-27) and the SP2a final review (2026-09-29), recorded in their ledgers.

| minor | defect | disposition |
|---|---|---|
| SP1 1 | tiny non-zero amplitudes (e.g. 1e-200) pass validation; Σa² underflows, giving saturated fields and NaN | SP2b §6.2 |
| SP1 2 | the spline validator accepts huge x or d (e.g. 1e308), which evaluate to NaN or ∞ | SP2b §6.1 |
| SP1 3 | invalid amplitude items count as 0 and add a spurious `AMPLITUDES_ZERO` | SP2b §6.2 |
| SP1 4 | lab `view.slice` is unvalidated; a non-finite slice makes the lab URL encoder throw | SP10 (lab) |
| SP1 5 | no `hashchange` listener; editing the fragment does nothing and is later overwritten | SP2b §1.4 for `?map`; SP10 for the lab |
| SP1 6 | the lab issues box keeps a stale message after switching noise or edit target | SP10 (lab) |
| SP1 7 | every lab camera change re-runs the full render and restarts both statistics passes | SP10 (lab) |
| SP1 8 | lab: a horizontal-only wheel event zooms in; no `pointercancel` handling | SP10 (lab; already fixed in the map) |
| SP1 9 | lab §6 departures: one readout value, mode u for non-uniform noises, wavelength input ignores the leaf range, "copy A → B" drops B's seed | SP10 (lab) |
| SP1 10 | the determinism panel stalls if a golden throws; clipboard failures are silent | SP10 (lab) |
| SP1 11 | the engine-dependent-API ban is bypassable via `.call`/`.bind`/`.apply` | fixed in SP2a |
| SP1 12 | the lab accepts seeds with CR/LF from the URL | SP10 (lab; already fixed in the map) |
| SP1 13 | the master's rule scopes omit `metrics/**` | fixed in SP2a |
| SP1 14 | `name in SPLINES` accepts prototype keys; "Statistics B" placement; side-panel scrollbar | SP10 (lab) |
| SP2a 1 | the tile/point bound admits x = 2^19, just outside the window | SP2b §6.3 |
| SP2a 2 | hovering past the world edge shows `BAD_MESSAGE` | SP2b §6.3 |
| SP2a 3 | no worker `onerror`: a worker that fails to load leaves configure pending | SP2b §2.3 |
| SP2a 4 | job-less errors carry no epoch, so a late error can reject the next configure | SP2b §2.3 |
| SP2a 5 | the no-allocation heap assertion is missing; lakes and steep allocate per call | SP3 |
| SP2a 6 | `B2.dryRiverBiome` is 0 by construction | SP3 |
| SP2a 7 | the lakes-layer colour blend is unclamped for Lw outside 63..200 | SP2b §6.3 |
| SP2a 8 | an invalid initial patch over a ready non-default profile keeps that profile | SP2b §1.2 |
| SP2a 9 | the selftest page leaves a rejected job unhandled and its summary stuck | SP2b §2.3 |
| SP2a 10 | the 256-entry tile cache thrashes on 4K viewports at level 4 | SP2b §2.5 |

## Threshold log

(One line per commit that changes `test/thresholds.lock.json`.)
