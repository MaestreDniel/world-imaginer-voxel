# Backlog (outside any sub-project's scope)

Improvements noted for later. They belong to no SP spec; pick them up when convenient.

## CI

- **Require `ci-ok` in branch protection** if branch protection is enabled for `main`: it is the one status that summarises every job, and it treats the skipped metrics jobs as success only on the docs-only path.
- **Rebalance the metrics-quick shards** when a job's slow-test summary shows one shard running much longer than the others (the shards are listed only in `metricShards.mjs`).

## Browsers

- **Verify the 3D page in Safari and other browsers (SP4a §11).** SP4a was measured and checked in Chrome (RegionBatch) and Firefox (RegionMesh) on Linux only. Safari needs a look at least for `SharedArrayBuffer` growth under COOP/COEP, `WEBGL_multi_draw` (which decides the section renderer) and the pointer lock.

## Controls

- **Configurable Ctrl+Z / Ctrl+Y for blocks** → master §10's SP10 entry ("Received from SP5c"), with SP5c's key map.

## Saved worlds

- **A world written by a newer build opens with its unknown states as air (SP5b final review PER-3).** When a later SP adds a block state, the world is saved with the longer `stateTable`, and an older build then opens it (a rolled-back deployment on the same origin and `wi10`), the open shows "n blocks of unknown types became air" and rewrites the world under the older table before it loads, so rolling forward again cannot bring those blocks back. This follows SP5b's D22 ("a key that no longer parses becomes air"; refusing the world was the rejected alternative), but D22 reasoned about removed or renamed states, not a newer build's. Should such a world be refused instead ("Made by a newer version of world-imaginer-voxel", as a newer `.wiworld` is), or opened without the rewrite and without editing? The user's call. The places: `tableRelation` and `remapOf` in `src/persist/saves.ts`, the `'other'` rewrite in `src/workers/simHandler.ts`'s `load`.

## Rendering

- **The T-junction pinhole specks (SP4a).** Isolated bright single-pixel specks where merged quads meet, likely T-junction pinholes letting the sky through: about 55 pixels in SP4a's `review-spawn-day.png`, 31 in the islands shot, 30-130 per panorama (SP4a spec, Exit evidence). The user (2026-10-23) sees them only in heavily shadowed or dimly lit places and keeps them for later. No SP owns them; after the user's check, pick a fix (for example a tiny overlap of merged quads, or splitting T-junction edges in the mesher) when convenient, or hand it to SP4b's mesher work or SP11's quality pass.

## Measurement tools

- **The RTX enter cell leaves fullscreen near the end of the run (SP5b final review GOV-3).** Both RTX 3060 runs of `measure:chrome --route enter` (13 page loads under ANGLE's Vulkan backend on PRIME offload) started fullscreen and ended with the window `normal` at 0,16 1919 × 1079 and a 1875 × 948 viewport; the one-load RTX bench and every Iris Xe enter run did not. `measureChrome.ts` reads the window only at the start and the end, so when it left is unknown. Fix: record the window state and viewport with each load's telemetry in `runEnter`, and stop the run or mark the pair invalid at the first load outside fullscreen 1920 × 1080 (a `measureChrome.test.ts` case with a fake window going `normal` at load 5).

## Code

- **Remove the dead `ui/shell.ts` and `ui/hud.ts`'s `mountHud`** (with their `.shell`, `.toolbar`, `.hud` and `.side-panel` CSS): the 3D page replaced SP0's boot shell in SP4a, so nothing mounts them. Removing them also updates master §1's `ui/shell.ts` entry and its pin in `test/arch/masterSpec.test.ts`.

## Performance

- **Firefox's IndexedDB commit cost (SP5b).** In Firefox 158 on the Iris Xe (`assets/sp5b/bench-iris-firefox.json`, recorded, not gated) one autosave flush's IndexedDB commit takes about 160 ms (`flushCommitP95Ms` 163; Chrome's gated file: 9.5), and an edit answered while a flush is in flight takes about 9 ms (`replyDuringFlushP95Ms` 9.14 over 34 edits, against `G2.flush`'s 5 ms budget for Chrome). No frame went over 33 ms in that run; Firefox's first run had one unexplained burst of 124 long frames in L11d (`bench-iris-firefox-run1.json`). To trace: whether the sim worker's write blocks the edit replies while the commit is out, and whether a smaller write per flush helps.
- **Stutter under heavy editing on the Iris Xe (SP5a).** The user (2026-10-29) noticed some stutter when interacting a lot with the world on the Iris Xe, and may repeat the check on the RTX 3060. SP5a's G2 gates one edit's visible latency (p95 ≤ 50 ms), not a burst of edits. To trace before a fix: the frame times during a burst of breaks and places, the edit remesh on the aux lane, the incremental relight's cost per batch, the mesh uploads on the iGPU, and the main thread's work per `edited` reply; then decide whether it belongs to SP11's performance pass or a fix of its own.
