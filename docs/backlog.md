# Backlog (outside any sub-project's scope)

Improvements noted for later. They belong to no SP spec; pick them up when convenient.

## CI

- **Require `ci-ok` in branch protection** if branch protection is enabled for `main`: it is the one status that summarises every job, and it treats the skipped metrics jobs as success only on the docs-only path.
- **Rebalance the metrics-quick shards** when a job's slow-test summary shows one shard running much longer than the others (the shards are listed only in `metricShards.mjs`).

## Browsers

- **Verify the 3D page in Safari and other browsers (SP4a §11).** SP4a was measured and checked in Chrome (RegionBatch) and Firefox (RegionMesh) on Linux only. Safari needs a look at least for `SharedArrayBuffer` growth under COOP/COEP, `WEBGL_multi_draw` (which decides the section renderer) and the pointer lock.

## Rendering

- **The T-junction pinhole specks (SP4a).** Isolated bright single-pixel specks where merged quads meet, likely T-junction pinholes letting the sky through: about 55 pixels in SP4a's `review-spawn-day.png`, 31 in the islands shot, 30-130 per panorama (SP4a spec, Exit evidence). The user (2026-10-23) sees them only in heavily shadowed or dimly lit places and keeps them for later. No SP owns them; after the user's check, pick a fix (for example a tiny overlap of merged quads, or splitting T-junction edges in the mesher) when convenient, or hand it to SP4b's mesher work or SP11's quality pass.

## Code

- **Remove the dead `ui/shell.ts` and `ui/hud.ts`'s `mountHud`** (with their `.shell`, `.toolbar`, `.hud` and `.side-panel` CSS): the 3D page replaced SP0's boot shell in SP4a, so nothing mounts them. Removing them also updates master §1's `ui/shell.ts` entry and its pin in `test/arch/masterSpec.test.ts`.

## Performance

- **Stutter under heavy editing on the Iris Xe (SP5a).** The user (2026-10-29) noticed some stutter when interacting a lot with the world on the Iris Xe, and may repeat the check on the RTX 3060. SP5a's G2 gates one edit's visible latency (p95 ≤ 50 ms), not a burst of edits. To trace before a fix: the frame times during a burst of breaks and places, the edit remesh on the aux lane, the incremental relight's cost per batch, the mesh uploads on the iGPU, and the main thread's work per `edited` reply; then decide whether it belongs to SP11's performance pass or a fix of its own.
