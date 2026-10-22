# Backlog (outside any sub-project's scope)

Improvements noted for later. They belong to no SP spec; pick them up when convenient.

## CI

- **Shard the unit project.** Since the parallel CI (2026-10-20), the `check` job (build, unit, arch, integration) is the longest job: unit and arch alone take about 157 s on the 4-vCPU runner. Splitting the unit project across two jobs (for example `vitest --shard`, or named heavy files plus a catch-all as `.github/scripts/metricShards.mjs` does) would bring a full run from about 3.5 min to about 2-2.5 min, and the docs-only path from about 3.3 min to about 1.5 min.
- **Require `ci-ok` in branch protection** if branch protection is enabled for `main`: it is the one status that summarises every job, and it treats the skipped metrics jobs as success only on the docs-only path.
- **Rebalance the metrics-quick shards** when a job's slow-test summary shows one shard running much longer than the others (the shards are listed only in `metricShards.mjs`).

## Browsers

- **Verify the 3D page in Safari and other browsers (SP4a §11).** SP4a was measured and checked in Chrome (RegionBatch) and Firefox (RegionMesh) on Linux only. Safari needs a look at least for `SharedArrayBuffer` growth under COOP/COEP, `WEBGL_multi_draw` (which decides the section renderer) and the pointer lock.

## Rendering

- **The T-junction pinhole specks (SP4a).** Isolated bright single-pixel specks where merged quads meet, likely T-junction pinholes letting the sky through: about 55 pixels in SP4a's `review-spawn-day.png`, 31 in the islands shot, 30-130 per panorama (SP4a spec, Exit evidence). No SP owns them; after the user's check, pick a fix (for example a tiny overlap of merged quads, or splitting T-junction edges in the mesher) when convenient, or hand it to SP4b's mesher work or SP11's quality pass.

## Code

- **Remove the dead `ui/shell.ts` and `ui/hud.ts`'s `mountHud`** (with their `.shell`, `.toolbar`, `.hud` and `.side-panel` CSS): the 3D page replaced SP0's boot shell in SP4a, so nothing mounts them. Removing them also updates master §1's `ui/shell.ts` entry and its pin in `test/arch/masterSpec.test.ts`.
