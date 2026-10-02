# SP2b — Parameter tooling (Design)

Date: 2026-09-30
Status: Complete (2026-10-02), at GENERATOR_VERSION 3; exit evidence below (design approved section by section by the user on 2026-09-30, revised after an adversarial spec review the same day and after the implementation-plan dry run, §13)
Parent: master spec `2026-09-26-architecture-design.md`. The sections involved are:
- §10 SP2b (deliverable, exit, cut line) and the SP2a cut-line items it receives;
- the module layout and its banned-API rule scopes: §1;
- the parameter and UI sections: §2.7 (presets, session, URL), §3.3 (spline validation), §3.10 (biome fitness), §5.1-5.4, §5.6;
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
- (Cut line) A **cross-section**: a two-click cut line on the map, profiled in a second drawer tab.
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
  types.ts         + SPLINE_MAX_ABS_X (2), SPLINE_MAX_ABS_D (1e5)
  validate.ts      + X_OUT_OF_RANGE, D_OUT_OF_RANGE
src/core/params/
  kit.ts           + AMPLITUDE_TINY; amplitude item handling
  schema.ts        spline leaves gain unit 'blocks'
src/engine/
  session.ts       draft model: set, reset, load, gestures, history, subscribe, modified
  workerPool.ts    abort cell, ABORTED, worker errors and removal, epoch-tagged errors, stats jobs, probe
src/gen/map/
  tile.ts          paintTileAbortable (stop callback, optional biome ids); single-sampled shaded preview
  layers.ts        lakes colour clamp
src/gen/column/
  spawn.ts         findSpawnAbortable
src/metrics/
  biomeShares.ts   shares, ties, outside (moved from test/metrics/biomes.metric.ts)
  splineStats.ts   histogram and segment shares of a spline node
  liveness.ts      U2 perturbations, liveness columns, witnesses, stage output hashes
  crossSection.ts  the columns along a cut line (cut line)
src/workers/
  protocol.ts      + abort cell, ABORTED, BAD_ARGS, error epoch, tile ids, stats job, half-open window
  taskHandler.ts   stop callback, stats kinds
src/ui/common/     dom.ts (el), base64url.ts, urlWriter.ts (moved from ui/lab), notice.ts + notice.css, keys.ts,
                   files.ts (text download and file read)
src/ui/map/        mapPage (composition), layout (grid, tabs, drawer tabs, splitters), toolbar, previewDriver,
                   mapView (canvas), fallback (fallback tiles, per-draw accounting), capacity (cache size),
                   highlight (biome masks), tileCache, tileSource, viewMath, mapState (+ hashchange),
                   hoverPanel (hover readout), biomeSize, perfHook (dynamic import), map.css
src/ui/paramPanel/ model.ts (pure), lints.ts (pure), controls.ts, panel.ts, panel.css
src/ui/splineEditor/ model.ts (pure), shapeFile.ts (pure), plot.ts, tree.ts, drawer.ts, drawer.css
src/ui/biomeTable/ model.ts (pure), table.ts, table.css, shares.ts + shares.css (cut line)
src/ui/presets/    presetFile.ts (pure), presetsTab.ts, presets.css
src/ui/crossSection/ model.ts (pure), section.ts, section.css (cut line)
src/ui/selftest/   selftestPage.ts: a rejected job is a failed key
test/tools/mapLatency.ts   the §2.8 exit runner (not in CI)
test/tools/uiSmoke.ts      the §8 UI smoke test, which also writes the §12 screenshots (not in CI)
```

The lab keeps its files and imports the moved helpers from `ui/common`. Each `*.css` file is imported by its module. The pure modules hold every rule that can be tested without a DOM; the DOM modules are covered by `uiSmoke.ts`.

## 1. State: the draft, history and URL (`engine/session.ts`)

`WorldSession` stays the single owner of the draft `{seedText, seed, profile, patch, params, epoch}`. Every editor, the slider, the URL and preset loads go through it.

### 1.1 Canonical minimal patch

- The stored patch is always `diffParams(SCHEMA, resolveProfile(profile), params)`, deep-frozen. The session never stores caller input.
- This fixes the −0 crash found in the context review: `applyPatch` accepts `-0` and q15s it to 0, but SP2a stored the raw patch, and `canonicalJSON` throws on −0 in `reconfigure()` and in the URL encoder. With the minimal patch, `canonicalJSON(state.patch)` never throws for a valid state (unit test).
- The epoch rule is unchanged: it increments only when the seed or `paramsHash(params)` changes. Epochs never go back: an undo that changes the seed or the params bumps the epoch too.

### 1.2 Edits

| method | effect |
|---|---|
| `setSeedText(text)` | SP1 seed rule, as today. |
| `newSeed()` | draws a random seed and writes its text back (the "New seed" button). |
| `setProfile(id)` | ready profiles only; clears the patch; one undo step even when the params do not change (default with `scaleMul` 4 → `large_biomes`), none when the draft is unchanged. The session never asks for confirmation (§3.1 shows the page's inline confirmation). |
| `set(path, value)` | `path` is a group or a leaf path; on a noise leaf `value` is a partial NoiseDef. Deep-merges `patchAt(path, value)` into the current patch (spline and boxTable leaves and arrays replace; groups and noise leaves merge per key, as `applyPatch` does) and validates over the profile. On failure nothing changes and the issues are returned for the control. |
| `reset(path)` | returns a group or a leaf (a noise leaf as a whole) to the profile's value, by removing it from the patch. |
| `load({seedText?, profile, patch}, {record = true} = {})` | atomic: resolves `seedText` with the SP1 rule when given (otherwise keeps the seed), validates the patch over a ready profile, then replaces seed, profile and patch in one commit: the epoch bumps at most once and subscribers are notified once. Records one history step (§1.3) unless `record` is false: then the load is not a step, and it replaces the snapshot at the history cursor, so the cursor still equals the draft. On failure nothing changes and the issues are returned. Preset import and the JSON box omit `seedText`; URL `hashchange` passes the hash's seed. |

- `modified(path)` and `modifiedCount(path)` take a group or a leaf path (`''` is the root group): whether the draft differs from the profile there, and how many leaves under a group differ. `modifiedCount('')` is the N of §3.1's profile-switch confirmation.
- Any other path passed to `set`, `reset`, `modified` or `modifiedCount` is a programming error and throws.
- Initialisation follows SP2a §4.3: an unready profile or an invalid patch falls back to `default` and `{}` with a notice (SP2a minor 8).

### 1.3 Gestures, history and notifications

- **Gestures** bracket a drag (slider, knot, tangent handle, interval bar). `beginGesture()` notifies `{kind: 'gestureBegin', urgent: false, gesture: true}`. Edits inside a gesture are non-urgent. `endGesture()` records the gesture's step (if the draft changed) and always notifies `{kind: 'gestureEnd', urgent: true, gesture: false}`, even when the draft did not change. Gestures do not nest: `beginGesture()` while one is active and `endGesture()` without one are no-ops. `undo`, `redo`, `load`, `setProfile`, `setSeedText` and `newSeed` called during a gesture first end it, then run.
- **Drag sources.** Pointer drags use `setPointerCapture`, begin their gesture at the first move beyond 2 px (a press that does not move only selects) and end it on `pointerup`, `pointercancel` or `lostpointercapture`. A native range slider begins its gesture on `pointerdown` and ends it on `change` or on the pointer's release (`pointerup` or `pointercancel` anywhere on the window), since a press that leaves the value unchanged fires no `change`. Keyboard steps on a range are ordinary urgent edits. Every edit outside a gesture is urgent.
- **History:** a list of up to 101 snapshots `{seedText, profile, patch}`, so up to 100 steps. A step is recorded when `canonicalJSON` of the new snapshot differs from the snapshot at the history cursor (the patch is minimal, so this never throws); a whole gesture is one step. The snapshot at the cursor therefore always equals the draft. A recorded step after an undo drops the redo tail; an unchanged snapshot records nothing and keeps it. The epoch key (seed, `paramsHash`) only decides whether the epoch changes and the preview reconfigures, never history: a profile switch that keeps the params (default with `scaleMul` 4 → `large_biomes`) and a seed text that resolves to the same seed (`42` → `042`) are recorded steps without an epoch bump.
- `undo()` and `redo()` move the cursor and apply the snapshot as `load(snapshot, {record: false})` does. They are urgent, record nothing and keep the redo tail.
- `subscribe(listener)` returns an unsubscribe function. Listeners receive `(state, change)` with `change = {kind: 'seed'|'profile'|'set'|'reset'|'load'|'undo'|'redo'|'gestureBegin'|'gestureEnd', urgent, gesture}` after every call that changes the draft, after every `undo()` or `redo()` that moves the cursor, and at gesture boundaries; apart from gesture boundaries, a call that fails or leaves the draft unchanged notifies nobody. `gesture` tells whether a gesture is active after the change, and `urgent` is its negation.

### 1.4 URL (`ui/map/mapState.ts`)

- The format is SP2a's: `?map#base64url(canonicalJSON({v: 1, seed, profile, patch, view: {x, z, bpp, layer}}))`, without gzip. The patch is the session's minimal patch, so a full 52-knot offset edit measured 2.3 KB. Master §2.7 is amended to this format (§10).
- **`hashchange`** (SP1 minor 5 for `?map`): decode the hash. If it is invalid, show the SP2a notice; the draft and the view do not change, and the URL is rewritten to them. An empty hash is the defaults, as when the page opens. Otherwise apply the view with `setView` (never a history step), then call `session.load({seedText: seed, profile, patch})` once (urgent); if the session refuses it, a notice names the first issue and the draft does not change. When the seed and params are unchanged this is a no-op. The raw decoded patch is never passed to `canonicalJSON`, because it may contain −0.
- Panel layout state (§3.1) is not in the URL.

### 1.5 Shared UI code (`ui/common/`)

- `dom.ts`: the `el(tag, className, text)` helper, today duplicated in `mapPage.ts` and `noiseLab.ts`.
- `base64url.ts` and `urlWriter.ts`: moved from `ui/lab/labState.ts` and `ui/lab/urlWriter.ts`, so `?map` no longer imports the lab (an arch test keeps it so).
- `notice.ts`: inline notices with optional actions (for example "Undo"), and an inline confirmation (Switch/Cancel) used by the profile switch (§3.1). Notices stack in the page's notice strip (§3.1); a notice with the same text replaces the older one, and a notice stays until dismissed unless it has a timeout. At most one confirmation is pending. No `prompt()`, `alert()` or `confirm()` anywhere in `ui/` (an arch test).
- `keys.ts`: the global shortcut handler (§3.5).
- `files.ts`: a text download and a `FileReader` read (with `onerror`), shared by shape files (§4.4) and presets (§3.4).

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
- **gen.** `paintTileAbortable(ctx, layer, level, tx, tz, out, stop, ids?)` checks `stop()` once per block row of the sampling pass of a preview tile (130 rows with the border for relief, rivers and lakes, whose colour pass samples nothing after §2.4), once per row of an unshaded fine tile and once per row of the sampling pass of a shaded fine tile, and returns null when stopped (the output buffers are then partly written). `findSpawnAbortable(ctx, stop)` checks once per ring and every 32 candidate points of a ring. Stats kinds check every 256 points. `paintTile` and `findSpawn` are wrappers with a `stop` that never fires, so their output, the goldens and `?selftest` do not change. `stop` is a plain callback: `gen` stays free of `Atomics` and worker APIs.
- **Without isolation** (for example a LAN address without COOP/COEP) the pool works as in SP2a, and the page shows the notice "live preview is slower without cross-origin isolation".
- **Barrier.** The all-workers ready barrier and its stage-hash and genKey agreement check stay. With abort, a busy worker answers within one row (≈ 2 ms rested, ≈ 3.5 ms under load).
- **Probe.** `pool.probe()` returns the busy workers, each in-flight job's type, epoch and tile level, the queue length and whether a configure waits for its barrier (for the §2.8 hook; the in-flight jobs are internal to the pool).

### 2.3 Worker errors (SP2a minors 3, 4 and 9)

- `ErrorMsg` gains `epoch: number | null`: the epoch of the message it answers (a configure's or a job's; for a malformed message its integer `epoch` field, else null, so a malformed configure still rejects itself). A job-less error whose epoch is not the pool's current epoch (null included) is ignored, so a late error of a superseded configure cannot reject the next one.
- `worker.onerror` and `onmessageerror` reject the pending configure and the failed worker's in-flight job with a `WorkerFailed` error, and the page shows "a worker failed; reload the page". The failed worker is terminated and removed: later configures wait only for the remaining workers, and once none is left every queued and new job and every configure rejects at once.
- The `?selftest` page handles a rejected job as a failed key, so its summary always completes.

### 2.4 Single-sampled shaded preview

- `paintPreview` samples each interior block twice for relief, rivers and lakes (once in the height pass, once for the colour). At level 256, `layerColor` for those layers reads only `surfaceEst` and `surfaceWaterLevel`; every other field it reads is a constant of `sampleCoarse` (no river, no lake).
- The height pass also stores the water level (`HEIGHT` and `WATER_LEVEL` exist), and the colour pass restores both into the record instead of sampling again.
- The output is byte-identical: the `sp2a.tile.relief.256` and `sp2a.tile.rivers.256` goldens guard it, and a unit test compares the lakes layer at 256 against a reference that samples twice. Measured: 109.7 → 55.3 ms per relief preview tile.

### 2.5 Fallback tiles (`ui/map/tileSource.ts`, `mapView.ts`)

- `clearSource()` is removed. `keyFor` still returns a key only for the pool's current epoch.
- The canvas keeps a **fallback key** per position `(layer, level, tx, tz)`: the key it last drew there. Where the current source has no cached tile, the canvas draws the fallback tile if it is still cached. Drawing a tile refreshes its LRU entry, so fallbacks stay cached while they are on screen. A fallback is replaced only when a tile of the current source is drawn at that position; a superseded source's late tile (possible without the abort cell) is cached but never drawn. No count of sources bounds the lookup. A fallback entry is dropped when its tile leaves the cache; entries are kept per layer, so a layer switch keeps them.
- **Draw order:** fallback tiles (coarse, then fine), then the current source's tiles coarse to fine. A current preview therefore covers a fallback fine tile: the map shows the new draft blurred rather than the old draft sharp.
- The spawn marker stays until the new spawn arrives. The hover readout shows the point of the current epoch only.
- **Preview progress.** After every draw whose source is the pool's current epoch, the canvas reports `previewProgress(poolEpoch, nearestDrawn, visible)` to the preview driver (§2.6): `visible` is the number of visible level-256 positions of the shown layer, and `nearestDrawn` the length of the longest nearest-first prefix of them that shows tiles of that source. The driver decides from it when a cycle lands.
- **Cache capacity:** `max(256, 3 × (visible target-level tiles + visible preview tiles))`, the tiles of the full plan (the view's level counted once when it is the preview level), recomputed on resize and on every view change, since a zoom changes the count as much as a resize (SP2a minor 10, now that fallbacks also occupy the cache). Lowering it evicts the least recently used entries at once. Biome-layer entries hold `{bitmap, ids}` (§5.3).

### 2.6 Preview driver (`ui/map/previewDriver.ts`)

A pure module with injected clock, pool and canvas interfaces. It turns session changes into configure cycles, and it owns the spawn request (in SP2a the page called `pool.spawn()` after `setSource`).

- **Cycles.** A cycle is: configure the pool with the draft, set the canvas source, and wait until the canvas's progress (§2.5) for the cycle's pool epoch covers every visible level-256 position. Each cycle records two epochs: the session epoch of the draft it configured, and the pool epoch of its configure (`ready.epoch`). At most one cycle is in flight.
- **Non-urgent edits** (inside a gesture) start a cycle when none is running; otherwise they replace the single pending draft ("latest wins"). The pending draft starts when the running cycle's preview lands. There is no timer: finished work is never discarded.
- **Urgent edits** (including `gestureEnd`) abort a running cycle that a gesture started and start at once. A cycle started by an urgent edit is never aborted by another urgent edit: the new draft waits in the slot (this prevents starvation under key-repeat undo). A draft that waited in the slot starts a cycle of its own urgency, so the guarantee holds through the slot.
- **Same epoch.** An edit whose session epoch equals the session epoch of the running or last cycle (for example a `gestureEnd` whose last draft is already shown) does not reconfigure and clears the slot; a failed cycle does not count, so sending its draft again retries it.
- **Interactive plan.** The canvas is interactive (`canvas.setInteractive(true)`: `request()` asks only for level-256 tiles) while a gesture is active or the slot holds a draft. As soon as neither holds it returns to the full plan, even if the running cycle has not landed: preview tiles keep their queue priority, then fine tiles.
- **Settled** means: not interactive, and the latest cycle has landed (or the latest edit had the same epoch). On settling, once per pool epoch, the driver calls `pool.spawn()` (spawn keeps priority −2, so it runs before queued fine tiles) and emits `onSettled`, which the statistics jobs use (§4.3, §4.5, §5.5).
- **Zoomed out.** When more preview tiles are visible than `pool.size`, a gesture cycle (one started by a non-urgent edit) counts as landed once the `pool.size` preview tiles nearest to the centre are drawn; the rest arrive after the gesture.
- **Watchdog.** A cycle that has not landed after `max(1000 ms, 3 × EWMA of recent cycle times)` from its configure counts as landed, and the pending draft starts. The EWMA weighs a new sample 1/4, and only preview landings feed it.
- **Errors.** A rejected configure of the newest cycle ends it: `JobCancelled` silently, any other error into the status. A spawn error other than `JobCancelled` also goes into the status.
- **Status.** The toolbar shows "last edit → preview N ms" (input time to the landing), then "· pending" while a cycle runs or the slot holds a draft, and "· error: …".
- **Effect.** During a drag nothing but preview tiles is ever in flight, so each configure is answered in about 2 ms even without the abort cell, and the heat that slows tiles 1.7× under sustained load is avoided.

### 2.7 View changes

- Pan and zoom never reconfigure: they call `setView`, and `request()` plans tiles for the current source under the current plan (interactive or full). Positions newly exposed by a pan or zoom have no fallback until their first tile lands.
- A layer switch draws the new layer's tiles; fallbacks are per layer.

### 2.8 Exit definition and measurement

- **Latency** = `drawnAt − inputAt`: from the input event's `timeStamp` (or `performance.now()` at a hook call) to the end of the animation-frame draw in which every visible level-256 position shows a tile of one source whose draft is the edit's or a newer one. The canvas reports only positions that show its current source (§2.5), so a frame that mixes two new-enough sources does not count: the measure can read late, never early. An edit whose draft is already on screen when the call returns (a release whose last draft has landed) has latency 0.
- **Blank draw:** after the page's first image (the first draw in which every visible level-256 position of the shown layer shows a tile), a draw in which a visible level-256 position of the shown layer that showed a tile (current or fallback) in the previous draw of that layer shows none. Positions newly exposed by a pan or zoom are not compared.
- **Hook:** `?map&perf=edit` loads `ui/map/perfHook.ts` by dynamic import. It pins the map canvas to 1100×825 CSS px (a page cannot set its device pixel ratio: the runner emulates DPR 1 and asserts it) with seed 42, the default profile, view (0, 0, 64 bpp) and the layer from the URL state: 4 preview tiles and 24 level-64 tiles, as in the baseline. It exposes:
  - `__wiPerf.set(path, value)`, `beginGesture()` and `endGesture()`, which call the session exactly as the editors do (urgency follows §1.3); `set` throws when the session refuses the value (a runner bug, never a measurement);
  - `__wiPerf.setWhenBusy(path, value)`: reads `pool.probe()` (§2.2) and, in the same task, calls `set` if at least one tile job of the view's level (64) is in flight; otherwise it returns false and the runner retries after the next animation frame;
  - the latency records with their breakdown (input → configure posted → all ready → preview jobs done → drawn), the blank-draw counter and the pool probe.
- **Edits:** `shape.offset` knot `[6, 0, 1]` via `withKnotY`, with a y value never used before in the page load: y = 97 + k/64 for its k-th edit (alternating two values would hit the tile cache).
- **Conditions:** all timing runs in the page, so CDP round trips never enter a measurement.
  - A, idle: no job in flight or queued, no configure pending and the driver settled, then 2 s of rest; 20 edits per gated layer per page load;
  - B, busy: 120 ms after each A edit's preview has landed, `setWhenBusy` once per animation frame until a level-64 job is in flight; 20 edits per gated layer per page load. A and B alternate, so every B edit follows a rested CPU (§2.1's rested busy case; C is the sustained case);
  - C, sustained: after a rest, 30 edits, each 100 ms after the previous preview;
  - D, drag: after a rest, `beginGesture()`, 3 s of `set` calls at 30 Hz and at 60 Hz, then `endGesture()` as the release (no new value); the release latency runs from `endGesture`'s `performance.now()` to the draw that shows the last draft's source or a newer one; 5 repetitions per rate.
- **Layers:** gated: biome and relief under the offset edit, in A-D, 3 page loads each. Reported, not gated, 1 page load each: the offset layer under the same edit, and biome-size slider steps (`climate.scaleMul` table values) on the biome and relief layers, each in A-D. The table has only 10 values, so each slider step of A-C follows its own unmeasured offset-knot edit with a new y and moves to the next position cyclically (…, 9, 10, 1, …), and a slider drag follows one such edit and then sweeps the positions one step per call, turning at 1 and 10 (repeats inside a drag hit the cache, as they would for a hand).
- **Pass** (D16, Chrome stable, 3 page loads per gated layer): max ≤ 300 ms in A, B and C and for every release in D; in D the longest stretch without a landing, from the drag's first edit through its landings to the release, is at most 500 ms; blank draws = 0 everywhere. Report p50, p95 (nearest rank) and max per condition; the pass rule uses the unrounded max.
- **Runner:** `test/tools/mapLatency.ts` (Node 24 type stripping, CDP over the global WebSocket). It runs `npm run build`, then `vite preview --host 127.0.0.1 --port <P> --strictPort`, where `<P>` is a free port it picks by binding port 0 and releasing it (never 5183, which the dev server and its container use; the COOP/COEP headers come from `preview.headers`). It treats the server as ready only when its own child process prints its URL, fails if that child exits or the port is taken, and never falls back to a server it did not start. It launches its own headless Chrome with a temporary profile (`--profile-dir` sets the profile's parent; Chrome keeps its singleton socket in `$TMPDIR`, which must be a short path), asserts `crossOriginIsolated` and `pool.abortable`, loads each page with one layer in the URL state and never switches layers or moves the view during a run. At the end it stops only the processes it started. JSON results go to `docs/superpowers/specs/assets/sp2b/latency-<layer>.json`, one file per layer holding its gated and reported runs.
- **Also recorded, not gated:** one run against production after the merge, and a Firefox check by the user (the status line after a few edits and a drag).

### 2.9 Deferred levers (not needed for the exit)

- A climate-grid cache per worker (a preview tile painted from a stored climate grid costs ≈ 6 ms instead of ≈ 54 ms): the lever if the 7-14 Hz drag cadence feels choppy, and for SP4's one-MAP-job cap.
- A preview key for rivers and lakes edits (their preview is identical, yet the shape hash changes), preview sub-tiles, and an intermediate level when zoomed in to 16 blocks/px or closer.

## 3. Page layout and parameter panel

### 3.1 Layout (`ui/map/layout.ts`, `map.css`)

- A CSS grid: toolbar row; the notice strip; main row with the map and the side panel; the drawer row under both. A draggable splitter sets the side panel width (280-520 px) and another the drawer height (160 px to 60 % of the viewport). The map canvas follows its host through the existing `ResizeObserver`.
- **Drawer:** a tab bar with Spline (§4.2) and Cross-section (§4.5). The drawer is closed until a spline is opened or a cut line is drawn, each opening it on its own tab; the Spline tab shows a hint until a spline is opened.
- Below 900 px of viewport width the side panel stacks under the map.
- Panel width, drawer height, active tab and open sections persist in localStorage under `wi10.layout.v1` behind try/catch (master §2.7 allows "panel layout"); a missing or invalid value gives the defaults, field by field. Panel visibility, the drawer's open state and its tab are not stored.
- **Toolbar:** layer select; seed input with "Same seed" (commits the typed text, as Enter does) and "New seed"; profile select (ready profiles); the biome-size slider (§6.4); undo and redo; grid toggle; Cut line (§4.5); the preview status (§2.6).
- **Profile switch:** when the patch is non-empty, choosing a profile first shows an inline confirmation "Switching to PROFILE clears N modified parameters" with Switch and Cancel (replaces `confirm()` at `mapPage.ts:130`). The confirmation is not modal: the select keeps showing the session's profile, and a newer choice replaces a pending confirmation. Cancel closes it; Switch calls `setProfile` and shows the notice "profile switched" with Undo, which acts only while the draft is still the one the switch made.
- **Notices** show in a strip under the toolbar, visible from every tab and with the panel hidden.
- **Tabs:** World (session status, hover readout, spawn), Parameters (§3.2), Biomes (§5), Presets (§3.4). Both tab bars (the side panel's and the drawer's) keep only the selected tab in the Tab order; ArrowRight and ArrowLeft move to the next and previous tab (wrapping), Home and End to the first and last, and the tab they reach is shown and focused. A key with Ctrl, Cmd, Alt or Shift is left to the browser.

### 3.2 Parameter panel (`ui/paramPanel/`)

- `model.ts` (pure) builds the panel tree from `SCHEMA.nodes` in schema order (a section shows its leaves before its sub-groups): each group is a section, each leaf a control spec `{path, kind, label, doc, unit, min, max, step, scale, scope}`.
- **Sections** are collapsed by default. The header shows the label, "n modified" and a section reset.
- **Controls by kind:**
  - `number` / `int`: a slider plus a numeric field. The slider is logarithmic when `min > 0` and `max / min ≥ 20` (for example `scaleMul`, and the noise fields persistence and `yScale`), linear otherwise. A linear stepped slider has one position per step (at most 1000), a logarithmic or unstepped one 1000. `step` is a UI hint and never snaps a typed value.
  - `noise`: a sub-block with wavelength (logarithmic over the leaf's wavelength range), octaves, persistence, lacunarity, amplitudes, `yScale`, `clampSigma`, `double` and `remap`, written with `session.set(<noise leaf>, partialNoiseDef)`. Fields a rule fixes are disabled with the reason in the tooltip (`yScale` is 1 for 2D noises; `remap: 'uniform'` needs `double` and 2D, so `double` is locked while it is set).
    - Amplitudes is a two-state toggle: `null` (the persistence weighting) or an explicit per-octave list. Switching to a list writes `q15(persistence^i)` for i < octaves, with any item below 1e-6 written as 0 (so `AMPLITUDE_TINY` cannot refuse the toggle); switching back writes `null`.
    - While a list is active, an octaves change writes `{octaves: n, amplitudes: resized}` in one call: the list is truncated, or extended with 0 for each added octave.
    - The sub-block has one modified dot and one reset for the whole noise leaf; its fields have no reset of their own.
  - `spline`: an "Edit" button that opens the drawer on the leaf, plus the leaf's modified dot and reset.
  - `boxTable`: a link to the Biomes tab.
- **On every control:** a scope badge (Climate: "recomputes everything"; Terrain: "recomputes shape and biomes, keeps raw climate"; the Live, Remesh and Decorate badges exist in the model for later leaves), a modified dot against the profile, a reset button, and a tooltip with the doc, range, unit and path.
- **Input:** slider drags are gestures (§1.3); a numeric field commits on Enter or blur (urgent) and Escape restores the draft value. An invalid value shows a red border and the issue text under the control; it is not applied, and it stays until Escape, a reset, or a change of that value in the draft.
- **Cross-field lints** (`lints.ts`, pure) are warnings, not validation: `rivers.coastFadeLo < rivers.coastFadeHi`, `rivers.altFadeLo < rivers.altFadeHi`, `lakes.offsetMin < lakes.offsetMax` (equal values are flagged too). The runtime already tolerates the inverted cases (a step instead of a fade, no lakes). Lints show under the controls they name and in a warnings list at the top of the panel; clicking one reveals its first leaf.
- Every leaf of today's schema has stage climate, shape or biome2d, so the panel shows only Climate and Terrain badges, and every leaf is covered by U2 (§7).

### 3.3 World tab

- Session status (seed, profile, epoch, workers, view), the hover readout (as today), and the spawn. Notices show in the page's strip (§3.1).

### 3.4 Presets tab (`ui/presets/`)

- **Export:** an inline name field. The name is trimmed and must be 1-64 UTF-16 units and not a profile id. The line under the field shows the file it saves, "enter a name" or the reason, and Export (the button or Enter) is disabled until the name is valid; an import fills the field with the preset's name. `exportPreset(name, profile, params)` is downloaded as `<file name>.wi10-preset.json`, where the file name keeps `[A-Za-z0-9 _.-]`, replaces other characters with `_` and is at most 64 characters.
- **Import:** a file input attached to the DOM, read with `FileReader` (with `onerror`; `ui/common/files.ts`). JSON parse errors and every `importPreset` issue are listed with their path. A preset whose profile is not ready yet gets "profile `archipelago` arrives in SP3" (from `readyFrom`). On success `session.load({profile, patch: diffParams(SCHEMA, resolveProfile(profile), params)})`, one undo step (none when the draft already equals the file), and the notice "loaded preset NAME", with Undo when the load changed the draft (it acts only while the draft is still the loaded one).
- **Advanced:** the JSON patch box, showing `canonicalJSON` of the minimal patch. Applying it (a button or Ctrl/Cmd+Enter) replaces the whole patch over the session's profile (`session.load({profile, patch})`, seed kept; empty text is `{}`). JSON errors and validator issues are listed under the box. Typed text stays until the draft's patch changes, and Escape restores it.
- The pure part (`presetFile.ts`: name checks, file names, parse and import to `{profile, patch}` or issues) is unit-tested.

### 3.5 Keys (`ui/common/keys.ts`)

- P shows or hides the side panel; Ctrl/Cmd+Z undoes; Ctrl/Cmd+Shift+Z and Ctrl+Y redo; Escape closes the drawer unless a text-entry control handles it first (§3.2). While the cut-line tool is armed, Escape cancels it instead (§4.5).
- Undo and redo are ignored only in a text-entry control, where the browser's own text undo applies: a `textarea`, a `contentEditable` element, or an `input` of type text, search, number, url, email, password or tel (an `input` without a type is text). Range, checkbox, radio, button and file inputs and `select` do not block them, so dragging a slider and then pressing Ctrl+Z undoes the drag. P is also ignored in a `select` (type-ahead).
- P and Escape act only without Ctrl or Cmd. No shortcut fires with Alt (or AltGr), on a key a control already handled (default prevented) or during an IME composition.

## 4. Spline editor (`ui/splineEditor/`, `core/spline/edit.ts`)

### 4.1 Pure edit operations (`core/spline/edit.ts`)

Each operation takes a spline and a `KnotPath` (SP1 addressing: `[7, 1, 1]` is `points[7].y.points[1].y.points[1]`) and returns `Result<NestedSpline>` validated with the leaf's `SplineOpts` (coords, `yMin`, `yMax`) and §6.1's bounds.

| operation | effect |
|---|---|
| `setKnot(s, path, {x?, y?, d?})` | sets a knot's x, numeric y or tangent; neighbours are untouched. |
| `insertKnot(s, nodePath, x, y)` | inserts a numeric knot into the node at `nodePath`; its tangent comes from SP1's `autoTangents` rule applied to that knot only, clamped to ±1e5 (§6.1). A duplicate x is refused (`X_DUPLICATE`). |
| `deleteKnot(s, path)` | removes a knot; a node cannot lose its last knot (`EMPTY`). |
| `nestKnot(s, path, coord)` | turns a numeric knot into a child spline over `coord` with two flat knots `{x: −1, y, d: 0}` and `{x: 1, y, d: 0}` (the value is unchanged everywhere). `coord` must be in the leaf's coords and unused on the path. |
| `flattenKnot(s, path, probe)` | replaces a child spline with its value at the probe coords; a value outside the leaf range is refused (`Y_OUT_OF_RANGE`), not clamped. |
| `autoTangentsAt(s, nodePath)` | recomputes the tangents of that node's knots (not recursive) with the SP1 rule, each clamped to ±1e5 (§6.1). |

- **Automatic tangents are clamped** to the validator's bound: PCHIP can exceed it for a knot inserted close to a neighbour across a large step (about 1.2e6 at a 2⁻¹⁰ gap over the offset's 384-block span). Tangents set explicitly (`setKnot`, a handle, a field) are validated, not clamped. The drawer's "auto tangents (spline)" applies `autoTangentsAt` to every node; SP1's `autoTangents(s)` is unchanged and unclamped, and gives the same spline on every default.
- A path that names no knot (or a node path through a numeric knot) is a programming error and throws, as in the session (§1.2). A knot of the wrong kind (a numeric y set on a nested knot, nesting a nested knot, flattening a numeric one) is refused with `Y_BAD_TYPE`.

`pathWeight` (the Hermite value-basis weight of a knot along a path, used by T6) moves from `test/harness/spline.ts` to `core/spline/weights.ts`, rewritten without `**`; T6 and the editor's statistics use it from there. The two versions cannot agree bit for bit (V8 rounds `t ** 3` and `t * t * t` differently), so the moved one is within 1e-15 of the SP2a version, and T6's values move by less than 1e-14.

### 4.2 Drawer

- **Header:** the leaf label and breadcrumbs from the typed coords (`offset › C=0.30 › E=−0.40`; coordinate values with two or three decimals); clicking a crumb goes up. **Probe** sliders over [−1, 1] set the coords the plot does not show but the curve reads below the open node (default 0); they are view state, not part of the draft (no undo, not in the URL). Buttons: auto tangents (node, spline), reset spline (to the profile), export and import shape, close.
- **Tree** on the left: every node with its coord and knot count (`C=0.30 → E (5 knots)`); clicking a node opens it.
- **Plot (SVG):**
  - x axis: the node's coord from `NestedSpline.coord`, over `[min(−1, x_first), max(1, x_last)]` so every knot is visible, with the hold regions beyond the end knots shaded and marks at ±L(coord), the coord's reachable range computed from the draft: `L = uMax(params.climate.<coord>.clampSigma)` for C, E, W, T and H (0.9973 at the default clamp of 3), and `L = 1` for PV, which the fold spans fully for every legal clamp (no marks). `model.ts` exports `reachLimit(coord, params)` for the marks and the lint;
  - y axis in blocks, over the leaf's range (the three spline leaves gain `unit: 'blocks'`); for offset, a line at sea level 63;
  - the curve is the generator's evaluation of the node with the other coords at the probe values; knots whose y is a child spline are drawn hollow at their evaluated value, and double-clicking one opens it.
- **Interaction** (the 08/09 SVG skeleton, master §1 deliberate port, rewritten against tests):
  - dragging a knot moves x between its neighbours (at least 2⁻¹⁰ apart; end knots within [−2, 2], §6.1) and y within the leaf range (a nested knot moves in x only); the knot keeps its offset to the pointer, and the plot's x range is kept for the duration of a drag;
  - the selected knot's tangent handle sets d, the slope from the knot to the pointer, clamped to ±1e5;
  - a numeric panel edits the selected knot's x, y and d;
  - double-clicking empty plot space inserts a knot on the curve; Delete removes the selected knot; a context menu offers, on a numeric knot, nest by a coord of the leaf that no node on the knot's path uses (`nestKnot`'s rule) and delete, and on a nested knot, open, flatten at the probe and delete;
  - clicking a lint entry selects its knot and opens its node;
  - drags are gestures (§1.3), so one drag is one undo step and a click only selects.
- `model.ts` (pure, unit-tested): plot transforms, hit testing, clamping, breadcrumb labels, probe vectors, `reachLimit`.

### 4.3 Overlays and lints

- **Statistics job** `splineStats` (§5.4): over a fixed stream of N = 60 000 points (`samplePoints('sp2b.splineStats', 60000)` in the colKey window) with the current seed and params, split across the pool. Each point i gets the weight `w_i = pathWeight` down to the open node (1 for the root).
  - A 64-bin histogram of the node's coordinate over [−1, 1] (the end bins take what lies beyond), binning the weights `w_i`.
  - Per segment `[x_k, x_{k+1})`, plus the two hold regions (q < x_0 and q ≥ x_{n−1}): `landShare_k = Σ_{i∈k, offset0_i ≥ 63} w_i / N_land` and `worldShare_k = Σ_{i∈k} w_i / N`, where `N_land` is the unweighted number of land points, so "this segment covers 7.3 % of land and 4.1 % of the world". A node's land shares sum to its mean weight over land points, and its world shares to its mean weight over all points.
  - Requested when the preview driver settles (§2.6), and when a node or the drawer opens while it is settled, so a request always runs on the draft the pool holds; only while the drawer shows the Spline tab and no gesture is active. A result belongs to the session epoch, leaf and node it ran on; only the latest request's result is used, and a request is not repeated for a target already shown or pending.
  - The overlays are stale (dimmed and labelled) while the draft's epoch differs from the result's or a gesture is active, until a new result arrives. A cancelled request (`JobCancelled`) leaves them stale silently; any other error leaves them stale and shows a notice.
- **Histogram shape.** Under CDF-uniform climate the histogram of C, E, W, T or H is flat; PV is not (it is folded from W), and nested nodes are conditional on their bracket. Master §5.3's "flat by construction" is amended (§10).
- **Lints:**
  - a knot is unreachable when its influence interval `(x_{k−1}, x_{k+1})` misses `[−L, L]` of its coord (§4.2); an end knot's interval is unbounded on its outer side, so an end knot is flagged only when its inner neighbour is at or beyond L on the same side (x_1 ≤ −L for the first knot, x_{n−2} ≥ L for the last); a node's only knot is never flagged. The default splines and `nestKnot`'s ±1 knots produce no such lint (unit test). The lint recomputes when a `clampSigma` changes;
  - a curve that leaves the leaf's y range between knots (checked at 512 points of the node from x_first to x_last, at the probe) is a warning with the largest overshoot. The validator checks y only at knots.
  - Lints are recomputed at most once per animation frame, after urgent changes, probe moves and opening the drawer, never per pointer move of a drag (a pass over the default offset costs about 18 ms); the previous list stays during a gesture.

### 4.4 Shape files (`shapeFile.ts`)

- Export writes `{format: 'wi10-shape', leaf, spline}` for the open leaf (`leaf` is `shape.offset`, `shape.sigma` or `shape.jag`) as `<leaf key>.wi10-shape.json`, for example `offset.wi10-shape.json`.
- Import validates the spline against the **open** leaf's coords and range and replaces the leaf (one undo step). `leaf` is optional on import: a file without it (the master's original format) is validated with no notice; a file whose `leaf` names another leaf is accepted if it validates, with a notice. Unknown envelope keys are errors. Errors are listed with their path.

### 4.5 Cross-section (cut line → SP10; `ui/crossSection/`, `metrics/crossSection.ts`)

- **Cut-line tool.** The toolbar's Cut line (or the Cross-section tab's New line) arms a two-click tool: A, then B, rounded to whole blocks. An end outside the world window `[−2^19, 2^19)`, or a B in A's block, is refused with a notice and the tool keeps waiting. While B is placed, a dashed line runs from A to the pointer; while the tool is armed, a click never pins the hover point. The toolbar button cancels it, and Escape cancels it before it closes the drawer (§3.5). The line stays on the map until Clear or a new line; a click within 6 screen px of it (tool off) reopens the Cross-section tab, so the profile stays reachable after the drawer is closed.
- **Samples.** `crossSection` samples 512 points from A to B inclusive, point i at A + (B − A)·i/511 kept within the segment's bounding box, with `samplePoint` (no steep): offset0, offset, σ, jag, the wet and gorge flags, the lake level and the surface water level. Sea level is the constant 63. Measured in Node: 2.6-3.4 ms per line warm, 29-40 ms for lines across the whole window.
- **Requests and stale state** follow §5.5: requested when the preview driver settles, when the tab comes on screen while the driver is settled and when a line is set, only while the drawer shows the Cross-section tab, no gesture is active and a line is set; one request per session epoch and line, and a new line drops the shown profile and the pending request. The tab is stale (dimmed, with its status) while the result's epoch differs from the draft's or a gesture is active. A cancelled request is silent; any other error shows the notice "cross-section failed: …".
- **Plot (SVG).** x is the distance from A in blocks; y is in blocks over every drawn value and sea level, padded by 5 % (at least 4 blocks). The ground is filled under offset, with offset ± σ as a band, offset as a line and offset0 as a thin dashed line. Water above the ground is filled to its level: at sea level (the ocean, and river channels below 63) or a lake, labelled "lake L". Sea level is a dashed line. River channels and gorges are stripes with a marker on the top edge. jag has its own strip under the axis, scaled from 0 to the next power of two from 8, because it is an amplitude, not a height. A hover cursor reads the nearest point; a summary line, a legend and the A and B labels complete it.

## 5. Biome table, highlight and statistics jobs

### 5.1 The table as it is (master §3.10 and §5.4 amended, §10)

- Rows: the 26 box biomes of `BOX_BIOMES`; river and frozen river come from the river flag; the height filter keeps ocean boxes below sea level and the other boxes above it (SP2a §3.2); cave biomes arrive in SP6.
- Columns: `[lo, hi]` on C, E, PV, T and H within [−1, 1]; `wSign` (−1, 0, +1); a unique priority (1-1000). No weights: the picker's fitness is the unweighted sum of squared overshoots.

### 5.2 Biomes tab (`ui/biomeTable/`)

- One row per box: colour swatch, name, family badge, five compact `lo, hi` text fields with a bar over [−1, 1] (the bar's ends are draggable, as gestures), a `wSign` select and the priority field.
- Every change writes the whole table with `session.set('biomes.table', table)` (the leaf is atomic, so one cell edit puts all 26 rows into the patch and the URL: about 2.8 KB of patch JSON). The edited cell shows its issue, which stays until Escape, a reset or a change of that cell:
  - `model.ts` checks a typed priority against the other 25 rows before calling `set` and refuses a duplicate with `DUPLICATE_PRIORITY` on the edited row and the message "priority N is also used by ROW", whatever the order, sort or filter;
  - a typed interval reads `lo, hi` (brackets optional; a comma, a semicolon or spaces between). Text that is not two parts, or lo ≥ hi, shows `BAD_INTERVAL` on that axis cell; a part that is not a number shows its own issue;
  - a press within 6 px of a bar end grabs it. Bar-end drags write values on a 0.01 grid (exact values are typed) and clamp lo to `[−1, hi − 2⁻¹⁰]` and hi to `[lo + 2⁻¹⁰, 1]`, so a drag never produces `BAD_INTERVAL`.
- Reset per row (to the profile's row) and for the table; a row reset is refused with `DUPLICATE_PRIORITY` on that row when another row now holds the profile row's priority, and the refusal shows under the row (the table reset always succeeds). Sort by priority, name or family; filter by family. Sort and filter are view state: not stored, not in the URL, no undo.
- Rows and cells that differ from the profile are marked (a dot per row, the cells' text), and the header counts the modified rows; the row and table resets are disabled while there is nothing to reset.
- `model.ts` (pure, unit-tested): rows, interval, sign and priority edits returning a new table, the priority check, interval clamping, row reset, sorting and filtering.

### 5.3 Row highlight on the map

- Biome-layer tiles also carry the biome id of every pixel: `paintTileAbortable` fills an optional `ids: Uint8Array(65536)` (preview tiles: the 2×2 block's sample), and `TileMsg` gains `ids?: ArrayBuffer` (transferred) for layer `biome` only. The tile goldens hash only RGBA, so they do not change.
- Hovering a row makes the canvas draw, over each visible biome tile, a mask that dims every other biome (about 0.2 ms per tile).
- **Memory.** Ids cost 64 KB per cached biome tile: 16 MB at the minimum capacity of 256 (§2.5), growing with the viewport-sized cache like the bitmaps, which are 4× larger. The mask cache holds masks for the hovered biome only, keyed by tile key; it is cleared when the hovered row changes, when the hover ends or when the source changes, and an entry is dropped when its tile leaves the tile cache.
- On other layers, the pointer entering the table's rows shows the notice "switch to the biome layer to highlight" once, not for each row it crosses (the notice strip would shift the rows under a still pointer). A layer switch while a row is hovered starts or ends the highlight.

### 5.4 The `stats` job

- **Protocol:** `{type: 'stats', jobId, epoch, kind, from, to, args}` → `{type: 'statsResult', jobId, epoch, kind, data}`. `data` is an ArrayBuffer (transferred) holding a Float64Array of raw, unnormalised weighted counts. Each kind's module in `src/metrics/` defines the layout and exports its length:
  - `splineStatsLength(n)` for a node with n knots: 64 histogram bins, then the land and all totals per region (the left hold, the n − 1 segments, the right hold), then the total weight, the point count N and the land point count N_land, so 2n + 69 values;
  - `biomeSharesLength()`: one count per surface biome id (28), then ties, outside and the total;
  - `crossSectionLength()`: 8 fields × 512 points (§4.5).

  The caller passes that length in `args.len`. `parseFromWorker` checks that `data` holds a whole, non-zero number of Float64 values, and the pool checks each slice's `byteLength === 8 × args.len` and rejects the request otherwise, so neither imports metrics.
- **Points:** `pool.stats(kind, n, args, priority = 500)` sums points `[0, n)` of the kind's fixed stream (60 000 for `splineStats`, 100 000 for `biomeShares`, the 512 line points for `crossSection`); a job's `from` and `to` select points `[from, to)`. The workers memoise the two streams.
- **Splitting:** for `splineStats` and `biomeShares` the pool splits the point range into `pool.size` slices, slice i covering `[⌊i·n/size⌋, ⌊(i+1)·n/size⌋)` (empty slices are not sent), runs them as ordinary queued jobs and adds the slice arrays element-wise in slice order, so the result does not depend on scheduling, without knowing the kind (`engine/` may import `metrics` only as types). The UI caller turns the sum into shares with the kind's summarising function. `crossSection` runs as one job over `[0, 512)`: `STATS_KINDS` in the protocol marks each kind `'split'` or `'single'`.
- **Scheduling:** stats slices run at priority 500 (after preview tiles, before fine tiles at 1000 + distance; spawn −2 and point −1 keep theirs). The first slice that fails rejects the request with its own error and the request's queued slices are dropped; nothing is retried, and in-flight siblings' results are discarded. A request cancelled with `JobCancelled` leaves its view stale silently, and the next `onSettled` (or the view coming on screen) sends a fresh one; any other error also shows a notice.
- **Arguments:** for `splineStats`, `args = {len, leaf: 'shape.offset' | 'shape.sigma' | 'shape.jag', node: KnotPath}`; for `biomeShares`, `{len}`; for `crossSection`, `{len, ax, az, bx, bz}`. `parseToWorker` checks the shape (a known kind, integers 0 ≤ from ≤ to, an integer `len` ≥ 1, a string `leaf` and an integer-array `node`, numeric line ends) and answers `BAD_MESSAGE`. The worker replies `error BAD_ARGS` when the arguments do not fit the configured params: an unknown leaf or a node that does not exist in the configured spline, a `len` that is not the kind's length, a `to` past the stream, or a line with an end outside the half-open window (NaN and ±∞ included) or with A = B. The view then stays stale.
- The computations live in `src/metrics/` so that tests call the same functions. Like `sp2aGoldens.ts` they follow the determinism rules: `DET_FILES` in `test/arch/rules/banned.ts` gains `metrics/splineStats.ts`, `metrics/biomeShares.ts`, `metrics/liveness.ts` and `metrics/crossSection.ts` (liveness is not a stats kind, but U2 shares the rules).

### 5.5 Biome share preview (cut line → SP10)

- `biomeShares` over `samplePoints('sp2b.biomeShares', 100000)` with the current seed and params: each point gets `columnPoint`'s biome, but the pick reads only the climate, offset0 and the river flag, so the lake and steep stages are skipped (unit-tested against a `columnPoint` loop). Counts per surface biome, ties and "outside every box" (ties and outside count non-river points only, as in B1). Estimated 270 ms on 6 workers; measured 110-250 ms in Chrome. With `columnPoint` it would take 1.9-2.4 s.
- **Requests.** Requested on `onSettled` while the chart is on screen (Biomes tab shown, panel visible, section open), and at once when it comes on screen while the driver is settled; a hidden chart stays stale and requests nothing, because each request takes every worker for 110-250 ms at priority 500, ahead of the fine tiles. A result belongs to the session epoch it ran on; superseded results are dropped, and a request is not repeated for an epoch already shown or pending. A cancelled request (`JobCancelled`) leaves the chart stale silently; any other error leaves it stale and shows a notice.
- **Chart.** A collapsible section above the table (open by default, not stored) with a bar per surface biome in registry order, on a linear scale (the largest share rounded up to 5 %, at least 20 %), a dashed 16 % mark on land rows, and a totals line (ocean family, ties, outside every box, points). It is stale (dimmed, with its status) while the result's epoch differs from the draft's or a gesture is active, until a new result arrives.
- **Warnings**, B1's limits (a unit test pins them to `test/thresholds.ts`): unreachable (< 0.1 %, every surface biome, rivers included), dominant (> 16 % for a land biome: coast, lowland or highland, as B1's largestLand), ocean family outside 25-45 %, ties (> 0), and outside every box > 2 %. A value at a limit passes, as in B1. Warned bars are marked.
- `src/metrics/biomeShares.ts` holds the counting and summarising that B1 uses today; `test/metrics/biomes.metric.ts` calls it. The move is checked by running B1 on every tier before and after it: the values must be identical.

## 6. Validation fixes and the biome-size slider

### 6.1 Spline bounds (SP1 minor 2)

- `validateSpline` gains `X_OUT_OF_RANGE` (|x| > 2) and `D_OUT_OF_RANGE` (|d| > 1e5 output units per unit of the coord: blocks for the three shape leaves; the validator is unit-agnostic). The bounds compare q15 values and are inclusive; `D_OUT_OF_RANGE` applies to a finite d only. SP1 §3.2's "|x| > 1 is legal" becomes "legal up to 2". Knots beyond ±1 never occur in the climate, and the editor lints unreachable knots by the §4.3 rule.
- With knot y inside the leaf range, these bounds guarantee finite evaluations. The contract "no issues ⇒ `compileSpline` succeeds" becomes "no issues ⇒ finite outputs everywhere", property-tested over random valid nested splines.

### 6.2 Tiny amplitudes (SP1 minors 1 and 3)

- `checkNoise` gains `AMPLITUDE_TINY`: every non-zero amplitude must have |a| ≥ 1e-6 (0 still silences an octave), so the squared sum can no longer underflow to 0 and turn samples into ±clamp or NaN.
- An amplitude item that fails its own check (not a finite number, out of range or tiny) gets its own issue and is not counted as 0, so it no longer adds a spurious `AMPLITUDES_ZERO`.

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
  - `boxTable`: every interval shrunk by 15 % of its width towards its centre (each end moves 7.5 %), and grown by 15 % (clamped to [−1, 1]).
- **Stage output hash** of a column, from the stage's own outputs on its ColumnSample (seed 42, default profile); a leaf is judged on the hash of its home stage (its `stage` meta):
  - climate: C, E, W, T, H, R and PV at the 49 lattice points;
  - shape: offset0, sigma0, jag0, offset, sigma, jag, riverDist, riverStrength, the river flags, lakeMask, lakeLevel, lakeFloor, surfaceWaterLevel and surfaceEst;
  - biome2d: the biome ids at the lattice points plus the per-block zoomed biomes of the column (`readBiome`), which is where `biomes.zoomJitter` acts.
- **Class columns** (`livenessColumns`): 16 columns, each chosen by the lattice condition under which its leaves act, scanning `samplePoints('sp2b.liveness', 200000)` with seed 42 and the default params:
  - 2 land columns with no water within 64 blocks (a dry lattice, a dry 16-block sample grid reaching 64 blocks beyond the column, and no river channel within a channel's half-width plus `wetMargin` of that grid);
  - 2 coast columns (|offset0 − 63| ≤ 8);
  - 2 channel columns: a lattice point with riverDist < width/2, riverStrength > 0 and offset0 in [63, altFadeLo); one of them also has a land lattice point with riverDist in [width/2 + 0.85·wetMargin, width/2 + 1.15·wetMargin);
  - 2 gorge columns: a lattice point with riverDist < width/2 and altFadeLo < offset0 < altFadeHi (strict);
  - 2 basin columns (a lattice point with lakeMask = 1);
  - 2 rim columns: a lattice point with 0 < lakeMask < 1 whose offset before the lake step is below Lw + 0.85·rimRise + 3·rimSigma (the downhill side of the rim, where `rimRise` acts);
  - 4 threshold columns, one each for `lakes.p`, `lakes.minC`, `lakes.offsetMin` and `lakes.offsetMax`: a lattice point with lakeMask > 0 whose nearest cell's probe (from the exported `lakeCell` and `cellEligible`) lies in a band where one of the leaf's perturbations turns the cell off (roll ∈ [0.85·p, p); C ∈ (minC, minC + 0.15·|minC|]; offset0 ∈ [offsetMin, offsetMin + 0.15·|offsetMin|); offset0 ∈ (offsetMax − 0.15·|offsetMax|, offsetMax]). When that band is empty within the scan, the loosening band, where a perturbation turns a disabled cell on, stands in (for example offset0 ∈ (offsetMax, 1.15·offsetMax] with every other eligibility test true); its lattice point needs lakeMask > 0 under the variant that enables the cell, since the base params give that cell no lake.
  - A unit test asserts that every class fills within the scan and names any empty class. The stream id is never changed to make U2 pass; if a class is empty, the scan length changes.
- **Witnesses.** A leaf whose perturbations change no hash on the 16 class columns is retested on witnesses: lake-gate leaves on the first lake cell, in a fixed spiral from (0, 0) up to 16 384 cells, whose `cellEligible` differs between the base and perturbed params and whose centre column's stage hash changes (that column is the witness; lakes are centred in warped lake space, so a flipped cell's centre column can lie outside its lake and keep its hash); every other leaf on the stream's columns that are not class columns, from the start, up to 2048, until a hash changes. A leaf is live if a class column or its witness changes the hash.
- **Metric** `U2.value` = live leaves / column-scope leaves, threshold min 1 (`activeFrom: 'SP2b'`), the same on every tier. The metric output (`test/metrics/.out/U2.leaves.json`) names each leaf's deciding column (class or witness); a failure names each dead leaf and the class meant to exercise it. Budget: under 1 s for the class columns, under 2 s for witnesses.

## 8. Tests

- **Unit:**
  - session: `set` (group, leaf, noise partial), `reset`, `load` with and without `seedText`, minimal patch, −0 input, `modified`, the SP2a minor 8 fallback, subscriptions;
  - history: 100 steps and the redo tail; default + `scaleMul` 4 → `large_biomes` → undo restores (default, `{climate: {scaleMul: 4}}`) with no epoch bump; `42` → `042` is one step without an epoch bump; undo and redo across a seed change restore `seedText`; a gesture that ends where it began records nothing; `endGesture` notifies an urgent `gestureEnd` when the draft is unchanged; undo during a gesture closes it first;
  - URL: `hashchange` with a new seed and patch gives one epoch bump, one notification and one step; a view-only change is not a step; an invalid hash changes nothing;
  - keys: the target predicate (range or select focused → Ctrl+Z handled; text, number or tel input focused → ignored);
  - preview driver with a fake clock and fake pool and canvas, whose pool epochs differ from the session's (for example starting at −1 and skipping): never two cycles in flight; no preview discarded by a gesture draft; urgent edits abort only gesture cycles; a same-epoch `gestureEnd` switches to the full plan without reconfiguring; interactive exactly while a gesture is active or the slot holds a draft; spawn requested once per settled epoch; the zoomed-out rule; the watchdog; a 60 Hz drag lands one preview per cycle;
  - fallback tiles: the last drawn key is used while cached and replaced only by a draw of the current source; a superseded source's late tile is never drawn; a zoomed-out view with 9 preview positions, `pool.size` 6 and 10 gesture cycles has no blank position;
  - pool (fake workers): a job-less error of a superseded epoch is ignored and the next configure resolves; `onerror` and `onmessageerror` reject the pending configure and that worker's in-flight job and remove the worker, and the next configure waits only for the others; `ABORTED` resolves as `JobCancelled`; aborting a stats request rejects it and drops its partial sums;
  - gen: `findSpawnAbortable` returns null when stopped and equals `findSpawn` otherwise; biome ids equal the biome of each pixel's sample point (preview: the 2×2 block's sample); the single-sampled preview equals the double-sampling reference for relief, rivers and lakes at level 256; the lakes colour is clamped at Lw 50, 63, 200 and 300;
  - hover and protocol: the half-open window `[−2^19, 2^19)`; a point outside it sends no job;
  - tile cache: capacity = `max(256, 3 × (visible target-level + visible preview tiles))`, recomputed on resize and on view changes;
  - spline edit operations (every issue path, and automatic tangents clamped to ±1e5), `pathWeight` (moved; within 1e-15 of the SP2a version) with T6 unchanged to 1e-14, editor model transforms, clamping and `reachLimit`, the unreachable-knot lint (no lint on the defaults or `nestKnot` output), shape files (with and without `leaf`);
  - panel model: tree from the schema, log-slider mapping, the amplitudes toggle and octave resizing, lints, badges; preset names and file names; presets tab logic (export = `exportPreset(name, session profile, session params)`, import = one `load` and one step); biome table model (priority check, interval clamping); the biome-size table and position mapping (each table value maps to itself without "≈"; 2 → 8, 2.01 → 8, 0.25 → 1, 16 → 10 with "≈");
  - `splineStats` and `biomeShares` against a direct computation; pool-split results equal a single-slice run exactly for `biomeShares` counts and for `splineStats` at the root node, and within 1e-10 relative for weighted sums of nested nodes;
  - §6.1-6.2 bounds, with property tests: no issues ⇒ finite outputs;
  - U2's class scan fills every class; the loosening band fills a threshold class when the tightening band is empty (`lakes.p` = 0); the witness search finds `lakes.minC`;
  - cut line: `crossSection` against a direct `samplePoint` loop (a coast line with sea, river channels, gorges and a lake; a diagonal fractional line; the window's corner-to-corner line); the cut tool; the request controllers of the share chart and the cross-section with a fake pool; the chart and plot models;
  - arch rules: no `prompt(`, `alert(` or `confirm(` under `src/ui`; `?map` does not import the lab.
- **Integration** (`worker_threads`, project `integration`, which `npm test` runs after the other projects, one file at a time, so the suite's parallel forks do not take the CPUs its threads need): with an abort cell, a level-4 relief tile stops within 50 ms of `Atomics.store` and replies `ABORTED`; the next tile, after a configure of the next epoch with the same cell, is byte-identical to a fresh worker's. The 50 ms is the handler's: from the store to `handle` returning in the worker, both read on `process.hrtime` (the monotonic clock all threads of a process share; the test wrapper stamps each reply). The delivery of the reply to the test's thread is not part of it, and the test blocks that thread for 60 ms after the store to keep it so. The two timing tests retry twice; the `ABORTED` and byte-identity checks hold on every attempt.
- **Metrics:** U2 (§7) on every tier.
- **Bench:** new rows `worker.configure`, `map.tile.b256.biome` and `map.tile.b256.relief`, gated at +30 % on D16. `npm run bench:record` rewrites every row, so the order is: `npm run bench` against the SP2a baseline (the existing rows must pass), then `npm run bench:record`, then `npm run bench`.
- **Tools (not in CI):**
  - the latency runner `test/tools/mapLatency.ts` (§2.8);
  - the UI smoke test `test/tools/uiSmoke.ts`: its own `vite preview` on a free port and its own headless Chrome, as §2.8's runner, with real pointer and key input through CDP and checks through the page's DOM and its URL hash (no test hook). It runs `?selftest=1`, then edits a number, drags a knot (one undo step; the statistics go stale and refresh), drags the slider (one step), edits a box (the share chart refreshes), switches profile with a modified draft (confirm, then the notice's Undo), exports a preset to a real download and imports it after the patch box applies `{}`, undoes and redoes the whole history with Ctrl+Z, Ctrl+Shift+Z and Ctrl+Y, reloads and checks that the draft, the controls and the stored layout come back, and draws a cross-section line. It fails on any exception, console error or failed load (the favicon.ico 404 aside: `index.html` declares no icon). `--shots DIR` writes the §12 screenshots.

## 9. Governance steps

- The first commit appends `'SP2b'` to `STARTED_SPS`, sets `CURRENT_SP = 'SP2b'` (no profile becomes ready: none has `readyFrom 'SP2b'`), accepts the thresholds lock and appends to the Threshold log below.
- The U2 row joins `test/thresholds.ts` with its own lock accept and Threshold-log line.
- The spline leaves' `unit` changes the README reference: `npm run docs:params`. The schema-shape lock records only leaf kinds, so it does not change.
- `DET_FILES` in `test/arch/rules/banned.ts` gains the four new metrics files (§5.4).
- No golden may change. Every generator-side change in SP2b is byte-identical (§2.2, §2.4); an unexpected golden change is a bug, not a re-record.
- D20 at exit: `?selftest=1` 47/47 in Chrome (also run by `uiSmoke.ts`) and Firefox, and Bun 47/47.

## 10. Master-spec amendments made with this spec

- **§1 (module layout):** `core/spline/` adds `edit.ts` and `weights.ts`; `metrics/` adds `biomeShares.ts`, `splineStats.ts`, `liveness.ts` and `crossSection.ts`; `ui/` adds `common/*`, `paramPanel/*`, `splineEditor/*`, `biomeTable/*`, `presets/*` and `crossSection/*` (the planned `paramPanel.ts` and `biomeTable.ts` become directories), and `ui/map/*` becomes the editor; `test/tools/` adds `mapLatency.ts` and `uiSmoke.ts`.
- **§1 (Banned APIs, the rule scopes, lines 161-162):** the determinism rules also cover the SP2b metrics files (`metrics/splineStats.ts`, `metrics/biomeShares.ts`, `metrics/liveness.ts`, `metrics/crossSection.ts`), listed as `DET_FILES`; the first bullet (`Math.random`, `Date.now`, `performance.now`, `console.*`) names the determinism files too, as the arch rule already does.
- **§2.7:** the world URL is `?map#base64url(canonicalJSON({v: 1, seed, profile, patch, view}))` with the minimal patch, without gzip (it replaces `#seed=…&profile=…&p=base64url(gzip(diff))`).
- **§3.3:** the validation sentence gains |x| ≤ 2 and |d| ≤ 1e5, and a spline without issues evaluates finite everywhere (§6.1).
- **§3.10:** fitness is the unweighted sum of squared overshoots with ties broken by `priority`; the table has no weights.
- **§4.3:** SP2b implements the epoch cell as one pool-wide cell for map, spawn and stats jobs; SP4 widens it to per-scope cells.
- **§5.1:** until SP4 the map previews the draft and there is no Apply; the session's gestures and urgency are the hooks SP4's Apply and SP5's fork dialog attach to.
- **§5.3:** tangents are data with explicit auto actions, and automatic tangents are clamped to ±1e5 (§4.1); undo and redo are global over the draft (100 steps) instead of 50 steps per spline; the coordinate histogram is flat only for C, E, W, T and H; nest and flatten are editor operations; shape files are `{format: 'wi10-shape', leaf, spline}` (§4.4); the breadcrumb example reads `E=−0.40`; the cross-section is a two-click line on the map, profiled in a drawer tab (§4.5).
- **§5.4:** the table has 5 axes, `wSign` and priority, no weights; 26 box rows plus the two flag biomes, narrowed by the height filter; cave biomes arrive in SP6; the share preview samples on the pool (≈ 270 ms for 100k points on 6 workers); the warnings add an ocean family outside 25-45 % and more than 2 % outside every box (B1's limits).
- **§5.6:** the tile cache holds `max(256, 3 × (visible target-level tiles + visible preview tiles))` entries (the view's level counted once when it is the preview level), recomputed on resize and on every view change; biome-layer entries hold `{bitmap, ids}`.
- **§6.4:** U2's perturbations per kind, stage output hashes, class columns and witnesses (§7).
- **§7:** "map preview after a spline edit ≤ 300 ms coarse" means every visible level-256 tile of the draft drawn, measured as in §2.8.
- **§10 SP2b:** add "Received from SP2a: the raw W/T/H/R layers and the grid overlay exist; the spawn fallback refinement is closed as not needed (N4 spawnOnLand is 100 % over 64 seeds with the SP2a fallback)", and remove it from the default cut-line receivers. SP3 receives SP2a minors 5 and 6, SP10 the lab minors (Appendix A). The SP2b cut line and its default receiver record which cut-line items SP2b delivered (nothing moves to SP10 when both are).
- **SP1 §3.2 and §4.2:** knots are legal up to |x| ≤ 2 and tangents up to |d| ≤ 1e5; `IssueCode` gains `X_OUT_OF_RANGE`, `D_OUT_OF_RANGE` and `AMPLITUDE_TINY`.
- **SP1 §3.4:** the editor applies the hybrid tangent rule per node (`insertKnot`, `autoTangentsAt`, "auto tangents") and clamps each automatic tangent to ±1e5 (§4.1); `autoTangents` itself is unchanged.

## 11. Notes handed to later SPs

- **SP3:** the editor's nest and flatten author the draft profiles' splines; amplified's post-multiplier (SP1 §10) should be baked into spline data, so the editor's y axis stays the terrain; the height filter's move to `surfaceEst` (SP2a §10) also moves the editor's land share and U2's classes to the new surface, and puts the lake stage into the share preview's pick, which makes it about 6× slower (≈ 1.6 s on 6 workers); SP2a minors 5 and 6 (Appendix A).
- **SP4:** mount the panel, drawer and table in the game; add Apply on top of the session's urgent commits; widen the epoch cell per scope; with the one-MAP-job cap, consider the climate-grid cache (§2.9).
- **SP5:** a named preset library in IndexedDB `presets`; the fork dialog on the first Apply.
- **SP10:** the cut-line items if they slip; the lab minors (Appendix A); the metrics dashboard reuses `src/metrics/biomeShares.ts`.
- **SP10 — minors deferred by the SP2b final review (2026-10-02):**
  - after a worker fails during a configure, the canvas keeps the old source until the next edit (`previewDriver.ts`);
  - Ctrl+Z during a range-slider drag makes each later slider position its own urgent undo step (`paramPanel/controls.ts`);
  - a map click becomes a pan after 1 px of movement, and every mouse button counts as a click (`mapView.ts`);
  - an unparseable worker reply leaves that worker busy (`workerPool.ts`);
  - the world window 2^19 is defined in five places;
  - `uiSmoke.ts` and `mapLatency.ts` share about 170 lines of process and CDP code, hardcode `/usr/bin/google-chrome`, and stop their children only on SIGINT, SIGTERM or a normal return; the smoke test counts four informational lines as checks and hardcodes the golden count.

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
| goldens unchanged; `?selftest=1` 47/47 in Chrome and Firefox; Bun 47/47 | goldens tests, browsers (Chrome also through `uiSmoke.ts`), Bun tool |
| bench within +30 % with the new rows | `npm run bench` |
| visual review | screenshots in `docs/superpowers/specs/assets/sp2b/`, written by `uiSmoke.ts --shots`: panel (`panel.png`), drawer with overlays (`drawer-overlays.png`), biome table with a highlighted row (`biome-table-highlight.png`), presets tab (`presets.png`), the map during a drag (`map-drag.png`), and for each cut-line item delivered, the biome share chart (`shares.png`) and the cross-section (`cross-section.png`) |

**Cut line:** the biome share preview (§5.5) and the cross-section (§4.5) → SP10.

## 13. Changes made by the implementation-plan dry run (2026-10-02)

The plan was dry-run in a scratch worktree: every task was implemented and every test run, including both cut-line items. These are the resulting changes to the approved spec:

1. **Automatic tangents are clamped to ±1e5** (§4.1, §4.2, §10). PCHIP exceeds §6.1's tangent bound when a knot is inserted close to a neighbour across a large step, so `insertKnot` would refuse an on-curve insert. "Auto tangents (spline)" applies the clamped `autoTangentsAt` to every node; SP1's `autoTangents` is unchanged.
2. **Session semantics** (§1.1-1.3). `setProfile` records no step when the draft is unchanged (§1.2 contradicted §1.3); listeners hear only changes of the draft, cursor moves and gesture boundaries; `load(…, {record: false})` replaces the snapshot at the cursor; epochs never go back.
3. **Gesture boundaries** (§1.3). A pointer drag's gesture begins at its first move beyond 2 px, so a click only selects; a range slider's gesture also ends on the pointer's release, because a press that leaves the value unchanged fires no `change`.
4. **Worker failures** (§2.3). A failed worker is terminated and removed, otherwise the next configure would wait for it forever; an error carries the epoch of the message it answers, so a malformed configure still rejects itself.
5. **Preview progress replaces `onPreview`** (§2.5, §2.6). After every draw the canvas reports how far the current source covers the visible preview positions, and the driver decides when a cycle lands (every position, or the `pool.size` nearest for a zoomed-out gesture cycle). The same-epoch rule holds for every edit, a slot draft keeps its urgency, and the watchdog's EWMA and the error status are specified.
6. **Fallbacks and cache size** (§2.5, §8, §10). A fallback changes only when a current tile is drawn (a superseded source's late tile is never drawn), and it is dropped with its tile. The capacity is recomputed on every view change as well as on resize, because a zoom changes the visible count as much as a resize does.
7. **The stats job contract** (§5.4). Point ranges, slices, the slice-order sum, the first-failure rule, the `BAD_MESSAGE`/`BAD_ARGS` split and the length check in the pool (a reply carries no `len`) are defined. `splineStats` also returns N and N_land (2n + 69 values), which the shares divide by.
8. **Spline overlays and lints** (§4.2, §4.3). The histogram covers [−1, 1], the hold regions are named, an end knot is flagged when its neighbour is at or beyond L, and lints are recomputed at most once per frame (a pass costs about 18 ms). Statistics are requested only while the Spline tab is on screen and belong to an epoch and a node. The probe, the context menu and a drag's frozen x range are specified.
9. **Biome share preview** (§5.5, §11). The pick skips the lake and steep stages, without which the 270 ms estimate cannot hold (`columnPoint` takes 1.9-2.4 s on 6 workers). A request occupies every worker ahead of the fine tiles, so it is made only while the chart is on screen. The chart and the coverage of each warning limit are specified, and SP3 is told that the height filter's move to `surfaceEst` brings the lakes back (≈ 1.6 s).
10. **Cross-section** (§4.5, §5.4, §3.1, §3.5). The two-click tool, the 512 samples and their fields, the request rule and the plot are specified; a click near the line reopens its profile, since nothing else leads back to it once the drawer is closed. The drawer gets a tab bar (Spline, Cross-section), the toolbar a Cut line button, and Escape cancels an armed tool before it closes the drawer.
11. **Page and editor details** (§1.4, §1.5, §3.1-3.5, §5.2, §5.3). Notices move to a strip under the toolbar, visible from every tab; the profile confirmation is not modal; refused values stay until Escape, a reset or a change of the draft; lints show in the panel; the biome table's interval text, bar grabs and grid, row-reset refusal and modified marks; the highlight notice shows once per entry into the rows, because the strip shifts them; an import equal to the draft records nothing; the patch box; `tel` inputs keep their text undo; an invalid `hashchange` rewrites the URL to the draft.
12. **U2 wording** (§7). A lake-gate witness must change its centre column's hash, because lakes are centred in warped lake space and a flipped cell's centre column can lie outside its lake; a loosening band needs lakeMask > 0 under the variant that enables the cell; a leaf is judged on its home stage's hash.
13. **Latency measurement** (§2.2, §2.8). `pool.probe()` exists for the hook; the runner emulates DPR 1, which a page cannot set; B runs 120 ms after each A landing; a draft already on screen lands at 0 ms; the drag cadence is the longest stretch without a landing; reported slider rows avoid tile-cache hits with an unmeasured knot edit; `--profile-dir` exists because Chrome's singleton socket needs a short `$TMPDIR`.
14. **`pathWeight` tolerance** (§4.1, §8). Without `**` the values cannot stay bit-identical (V8 rounds `t ** 3` and `t * t * t` differently): the moved function is within 1e-15, and T6 within 1e-14.
15. **Tools, bench and visual review** (§8, §9, §12). `test/tools/uiSmoke.ts` is named; it also runs `?selftest=1` in Chrome and writes the screenshots. The bench runs `bench`, `bench:record`, `bench`, because `bench:record` rewrites every row. The visual review adds the share chart and the cross-section, with file names.
16. **Module layout and determinism files** (Module layout, §5.4, §9, §10). The files the implementation added are listed, among them `ui/map/toolbar.ts`, `fallback.ts`, `capacity.ts` and `highlight.ts`, `ui/common/files.ts`, `ui/crossSection/`, `metrics/crossSection.ts`, the CSS files and `uiSmoke.ts`. `DET_FILES` gains four SP2b files. §10 adds the master §1 layout, §3.3, the §5.3, §5.4 and §5.6 details and SP1 §3.4, and its rule-scope entry now points to master §1, not §2 (the Parent list names §1 and §3.3).
17. **Wording** (§2.2, §3.2, §4.2, §6.1, §6.2). Preview tiles poll `stop` per row of their sampling pass; the log rule's examples include persistence and `yScale`, which the noise sub-block now lists; sections show leaves before sub-groups; the breadcrumb and tree examples match the defaults (`E=−0.40`, 5 knots); the tangent bound is in output units; every amplitude item that fails its own check is kept out of the all-zero check.

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

## Exit evidence

Implementation of the plan (2026-10-02, branch `sp2b/parameter-tooling`, Tasks 1-24, measured at Task 24; 12th Gen Intel(R) Core(TM) i7-12700H with 20 threads, Node v24.21.0, Chrome 153.0.8010.36). Every number below was measured on that branch; the dry run's block (scratch branch `dry/sp2b`) is replaced.
- `npm run typecheck`, `npm run build`, `npm test` (1182 passed, 2 skipped, 40 s, at the final-review fixes), `npm run test:metrics` (55 s, with other work loading the machine) and `npm run test:metrics:full` (127 s) all green.
- Abort test (§8, fixed after the final review). At Task 24, three of five `npm test` runs under load from other work (load average 5-12) failed `test/integration/abort.test.ts` at 51.7 and 68.9 ms: it timed the store to the main thread's handling of the reply and ran next to the suite's parallel forks. It now times the handler in the worker and runs in its own `integration` project after the others. Pinned to 4 CPUs as on a CI runner (`taskset -c 0-3 npm test`), 8 of 8 full runs were green, with the handler stopping 0.09-2.01 ms after the store on every first attempt; the Task 24 tree failed 1 of 8 such runs (141.2 ms). With 24 extra spinning threads on the 20 CPUs, the Task 24 tree failed the abort test in 3 of 3 full runs (62.2, 94.7 and 133.2 ms). The fixed tree passed it on the first attempt in 5 of 5 runs (13.4-36.9 ms). Under that artificial load only, the unrelated `test/unit/splineFixtures.test.ts` test 6 (2.5 s idle) exceeded its 30 s timeout in both fixed-tree runs whose full output was kept. A third run had one failure that was not identified, and the Task 24 tree also had second failures under that load.
- `git diff main -- test/goldens.json` is empty: no golden changed (§9). GENERATOR_VERSION stays 3.

Metrics that SP2b adds or touches (`test/metrics/.out/*.json` after each tier). U2 decides all 51 column-scope leaves on its class columns (land 17, basin 11, channel 10, gorge 4, rim 3, coast 2, one per lake gate), so no witness is needed. B1 equals the SP2a Exit evidence (GENERATOR_VERSION 3 block) on every tier: the counting moved to `src/metrics/biomeShares.ts` without changing a value (§5.5). T6 now uses `pathWeight` from `core/spline/weights.ts` (§4.1). Every other metric is unchanged.

| metric | fast | quick | full |
|---|---|---|---|
| U2.value | 1 | 1 | 1 |
| U4.registryIssues | 0 | 0 | 0 |
| U4.migrationFailures | 0 | 0 | 0 |
| U4.shapeLockViolations | 0 | 0 | 0 |
| U4.readmeStale | 0 | 0 | 0 |
| B1.minShare | 0.0037 | 0.0037 | 0.0037 |
| B1.minRareShare | 0.0067 | 0.0065 | 0.0066 |
| B1.largestLand | 0.0676 | 0.0683 | 0.0682 |
| B1.oceanFamily | 0.4412 | 0.4407 | 0.4408 |
| B1.ties | 0 | 0 | 0 |
| B1.outside | 0.0018 | 0.0017 | 0.0017 |
| T6.minGain | 9.999999999999979 | 10.00000000000002 | 9.999999999999964 |
| T6.maxGain | 10.00000000000003 | 10.000000000000052 | 10.00000000000007 |

Edit → preview latency (§2.8; `node test/tools/mapLatency.ts`, run of 2026-10-02 at `7cb63fc` on a clean tree, after every change to the measured page; it replaces Task 21's run at `ae4fe24` with a dirty tree. JSON in `assets/sp2b/latency-{biome,relief,offset}.json`. The runner used to read `git describe --dirty` as it wrote each file, so the files after the first were labelled `7cb63fc-dirty` by its own output. `3c387af` reads the source once at the start, and the two labels were corrected to `7cb63fc`. A `--quick` run at `3c387af` labels all three files with the clean SHA). Headless Chrome, 6 workers, cross-origin isolated and abortable, 1100 × 825 canvas at DPR 1, seed 42, view (0, 0, 64 bpp). The edit is `shape.offset` knot [6, 0, 1] with a new y each time; "size" rows step the biome-size slider instead. Values are p50 / p95 / max in ms; the D columns give the release max, then the longest stretch without a landing during the drag:

| layer · edit | loads | A idle | B busy | C sustained | D 30 Hz | D 60 Hz | blank draws | verdict |
|---|---|---|---|---|---|---|---|---|
| biome · knot | 3 | 92.5 / 122.3 / 130 | 96.4 / 114.9 / 146.6 | 166.3 / 169.4 / 217.7 | 148.1 · 150.1 | 146.6 · 150 | 0 | pass |
| relief · knot | 3 | 99.9 / 122 / 140.3 | 99.1 / 113.2 / 115.7 | 166.3 / 183 / 185.7 | 157.9 · 179 | 153.7 · 150.2 | 0 | pass |
| offset · knot | 1 | 98.8 / 118.4 / 123.7 | 96.8 / 113 / 113.1 | 166.3 / 168.5 / 180.3 | 148.3 · 139.8 | 145.8 · 133.9 | 0 | reported |
| biome · size | 1 | 91.4 / 107.2 / 115.8 | 96.4 / 126.3 / 129.6 | 166.4 / 183 / 183 | 0 · 150 | 10.2 · 89.6 | 0 | reported |
| relief · size | 1 | 97.1 / 132.5 / 136.2 | 96.8 / 116.6 / 124.2 | 166.3 / 183.1 / 184.3 | 0 · 100.2 | 7.4 · 89.5 | 0 | reported |

- Every gated row passes:
  - max ≤ 300 ms in A, B and C and for every release;
  - a landing at least every 500 ms during each drag (26-29 landings per 3 s knot drag at 30 Hz, 26-28 at 60 Hz);
  - no blank draw.
- In B, 6 level-64 tiles were in flight at every edit.
- The all-ready barrier closed within 9.4 ms (A, B and C, every row).
- No page error.

Bench (`npm run bench`, gated at +30 % against the baseline Task 21 recorded; 18 kernels, 3 of them new in SP2b; `killRatio 0.839`; `column.sample p50 0.398 ms, p99 (≥ p95) 0.517 ms`):

| kernel | ns/eval | ratio to calibration |
|---|---|---|
| `calibration.fmix32` | 0.636 | 1 |
| `lattice3.slice` | 22.164 | 34.863 |
| `perm512.slice` | 28.099 | 44.198 |
| `lattice3.random` | 22.62 | 35.58 |
| `perm512.random` | 26.975 | 42.43 |
| `normal.z2.climateC` | 314.962 | 495.424 |
| `normal.z3.density3d` | 215.966 | 339.707 |
| `spline.offset` | 44.675 | 70.273 |
| `spline.mix3` | 86.81 | 136.548 |
| `detErf` | 3.12 | 4.908 |
| `stageHashes.genKey` | 190152.75 | 299103.558 |
| `column.point` | 15536.219 | 24437.923 |
| `column.sample` | 397761 | 625664 |
| `map.tile.b64.biome` | 375046234 | 589934475.596 |
| `map.tile.b16.relief` | 356753078.5 | 561159988.297 |
| `worker.configure` (SP2b) | 677452 | 1065608.061 |
| `map.tile.b256.biome` (SP2b) | 59423739.5 | 93471442.777 |
| `map.tile.b256.relief` (SP2b) | 61834440 | 97263389.492 |

JavaScriptCore: `npx --yes bun@1 test/tools/goldensJsc.ts` → `47/47 match on Bun 1.4.2 (JavaScriptCore)`.

Browser checks (`node test/tools/uiSmoke.ts --shots docs/superpowers/specs/assets/sp2b`: `vite preview` on its own port and headless Chrome 153, 1400 × 900 at DPR 1; 42 s including the build) → `smoke: 64/64 checks pass` at Task 24. At the final-review fixes (`7cb63fc`, without `--shots`, so the screenshots are Task 24's) → `smoke: 71/71 checks pass`. The 7 new checks are the tab keys of §3.1, and 5 of them fail on the Task 24 tree. What the checks cover:
- `?selftest=1`: `✓ all 47 goldens match (5.5 s)`.
- `?map` at seed 42: the first preview landed in 177 ms. A typed `rivers.gorgeDepth` 40 shows its modified dot and the counts. A dragged `shape.offset` knot is one undo step, and its statistics go stale during the drag and fresh after the settle. The biome-size slider dragged from 5 to 8 writes `scaleMul` 2.29739670999407 as one step. A typed desert T interval writes the whole table, and the share chart refreshes.
- The switch to large_biomes asks "Switching to large_biomes clears 4 modified parameters". Switch loads the profile with an empty patch, and the notice's Undo brings the 4 parameters back.
- The exported `smoke test.wi10-preset.json` is a real download whose `params` equal the draft's patch. After the patch box applies `{}`, importing the file restores the draft as one step.
- Ctrl+Z walks back the 6 steps to the start, and Ctrl+Shift+Z and Ctrl+Y walk forward again. A reload restores the URL draft, the controls and the stored layout.
- A two-click cut line opens the Cross-section tab with a fresh profile.
- On the side panel's tabs, ArrowRight from Presets wraps to World, then goes on to Parameters. ArrowLeft goes back to World, End goes to Presets and Home to World. In the drawer, ArrowLeft and ArrowRight switch between Cross-section and Spline. Each key shows and focuses the tab it reaches.
- No exception, console error or failed load apart from the favicon.ico 404 (index.html declares no icon).

Screenshots (`docs/superpowers/specs/assets/sp2b/`, 1400 × 900, seed 42, 256-colour palette PNGs, written by the smoke test's `--shots`):
- `panel.png`: the Rivers section with `widthMin` 12 (modified dot, section count, the width noise sub-block);
- `drawer-overlays.png`: the spline drawer on `shape.offset` with the histogram and the land and world shares, knot 0 selected;
- `map-drag.png`: the map during a knot drag (preview tiles only, the statistics stale);
- `biome-table-highlight.png`: the biome table with the pointer on the plains row, highlighted on the biome layer;
- `presets.png`: the Presets tab with a name typed;
- `shares.png`: the biome share chart, fresh, with no warning;
- `cross-section.png`: a cut line across a coast at 4 blocks/px (sea, a river channel, 2 gorges, a lake at 153).

Done after the merge (2026-10-02):
- `main` fast-forwarded to the branch and pushed at 6f14137 (the user chose a local merge; pushing to `main` is authorised), so the CI evidence is the push run: GitHub Actions green in 3 min.
- Production (Vercel) serves the same bundle as the local build. In headless Chrome: `?selftest=1` `✓ all 47 goldens match (6.1 s)`; `?map` shows the editor (World, Parameters, Biomes, Presets; Spline and Cross-section drawer; biome size, Undo/Redo, Cut line) with no console errors.
- Production, Firefox 157 (the user): `?selftest=1` 47/47, and every `actual` equals `test/goldens.json` (generatorVersion 3); the JSON is in `assets/sp2b/selftest-firefox.json`. The editor's status line, as read by the user: undo 23, 26 and 43 ms (the restored draft's tiles are cached); `shape.offset` knot edits 105, 140, 143, 220, 288 and 319 ms. The status line measures from the input to the landing of the release cycle, outside the §2.8 pinned conditions, and is reported, not gated; one reading is over 300 ms in Firefox, against a gated Chrome maximum of about 200 ms.
- The §2.8 latency runner was not pointed at production: it builds and serves `dist` itself, and the production bundle is byte-identical to that build. Its gated runs are the evidence above.

SP2b is complete (2026-10-02): every §12 exit criterion holds.

## Threshold log

(One line per commit that changes `test/thresholds.lock.json`.)

- Task 1: `STARTED_SPS` gains `SP2b`; no threshold rows change.
- Task 9: new row `U2.value` min 1, active from SP2b, the same on every tier (parameter liveness, §7).
