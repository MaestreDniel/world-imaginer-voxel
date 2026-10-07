# world-imaginer-voxel

A Minecraft-inspired procedural voxel world for the browser: an explorer **and** editor (break/place blocks, real flowing water), built with TypeScript, Vite and three.js (WebGL2, custom GLSL3 shaders).

It is the successor of [world-imaginer](https://github.com/MaestreDniel/world-imaginer), a research repository whose projects 01-09 explored noise, heightmaps, biomes, splines and density terrain. This repository starts from a clean scaffold and a measured diagnosis of `09-density-terrain`.

## Status

SP0, SP1, SP2a, SP2b and SP3a are complete: `?map` shows the generated world's biomes, relief, rivers and lakes and edits every parameter, spline and biome box with a live preview (parameter panel, spline editor, biome table with share chart, presets, cross-section, undo/redo); the cross-section's Voxels mode shows the real vertical slice of voxels (SP3a: block registry, shared voxel store and a provisional terrain stage filled from the 2D world), and `?selftest=1` checks every golden in the browser (deployed at https://world-imaginer-voxel.vercel.app). SP3b (density, surfaceEstimate, terrain and surface rules) is next.

## Development

```bash
npm install
npm run dev            # http://localhost:5183 (must be localhost or HTTPS)
npm run build          # typecheck + production build
npm test               # unit + arch + fast metrics, then the worker-thread integration tests
npm run test:metrics   # quick metric tier (CI)
docker compose up world-imaginer-voxel
```

## Design

- Master architecture spec: [`docs/superpowers/specs/2026-09-26-architecture-design.md`](docs/superpowers/specs/2026-09-26-architecture-design.md). Its decisions log (D1-D20) is the source of truth.
- Work is split into sub-projects SP0-SP12 (§10 of the spec), each with its own spec → plan → test-driven implementation.

Highlights of the design:

- **Generation:** unaliased, aperiodic seeded noise; 6D multi-noise climate (temperature, humidity, continentalness, erosion, weirdness, depth) with uniform distributions; climate-only terrain shape via nested Hermite splines; a data-driven 3D density composition with cheese/spaghetti/noodle caves, visible entrances, carvers and ravines; aquifers with water and lava; rivers and elevated lakes; surface and cave biomes (lush, dripstone, abyss); jigsaw-lite structures; extreme presets (amplified, archipelago, floating islands, large biomes, cave-heavy).
- **Engine:** SharedArrayBuffer voxel store with u16 block states, worker pool, exact cross-chunk lighting, greedy meshing with an 8-byte vertex, opaque/cutout/translucent passes, translucent fluid water, sky and day/night, far-terrain LOD, scalable graphics presets.
- **Sandbox:** editing with real-time fluids, saves in IndexedDB with export/import, procedural textures and audio with loadable resource and sound packs.
- **Research tooling:** live map, spline editor, biome table, density inspector, slice views and an in-app metrics dashboard backed by the same metric tests that gate CI.

## Parameters

Generated from `src/core/params/schema.ts` by `npm run docs:params`; a test fails when it is stale.

<!-- params:begin -->
| path | kind | default | range | unit | scope | doc |
|---|---|---|---|---|---|---|
| `climate.scaleMul` | number | 1 | 0.25 … 16 |  | climate | Climate scale: Zooms every climate wavelength, warp wavelength and warp amplitude (large_biomes = 4). |
| `climate.warp.shift.amplitude` | number | 48 | 0 … 1000 | blocks | climate | Amplitude: Maximum displacement of the warp. |
| `climate.warp.shift.noise` | noise | {"amplitudes":null,"clampSigma":3,"double":true,"lacunarity":2,"octaves":3,"persistence":0.5,"remap":"none","wavelength":256,"yScale":1} | wavelength 16 … 8192 |  | climate | Warp noise: Unit-sd noise sampled twice (.x and .z) to displace the coordinates. |
| `climate.warp.C.amplitude` | number | 180 | 0 … 1000 | blocks | climate | Amplitude: Maximum displacement of the warp. |
| `climate.warp.C.noise` | noise | {"amplitudes":null,"clampSigma":3,"double":true,"lacunarity":2,"octaves":2,"persistence":0.5,"remap":"none","wavelength":1024,"yScale":1} | wavelength 16 … 8192 |  | climate | Warp noise: Unit-sd noise sampled twice (.x and .z) to displace the coordinates. |
| `climate.warp.R.amplitude` | number | 120 | 0 … 1000 | blocks | climate | Amplitude: Maximum displacement of the warp. |
| `climate.warp.R.noise` | noise | {"amplitudes":null,"clampSigma":3,"double":true,"lacunarity":2,"octaves":2,"persistence":0.5,"remap":"none","wavelength":512,"yScale":1} | wavelength 16 … 8192 |  | climate | Warp noise: Unit-sd noise sampled twice (.x and .z) to displace the coordinates. |
| `climate.C` | noise | {"amplitudes":null,"clampSigma":3,"double":true,"lacunarity":2,"octaves":6,"persistence":0.5,"remap":"uniform","wavelength":2400,"yScale":1} | wavelength 64 … 20000 |  | climate | Continentalness: Ocean ↔ inland. |
| `climate.E` | noise | {"amplitudes":null,"clampSigma":3,"double":true,"lacunarity":2,"octaves":5,"persistence":0.5,"remap":"uniform","wavelength":1600,"yScale":1} | wavelength 64 … 20000 |  | climate | Erosion: Flat ↔ mountainous. |
| `climate.W` | noise | {"amplitudes":null,"clampSigma":3,"double":true,"lacunarity":2,"octaves":5,"persistence":0.5,"remap":"uniform","wavelength":900,"yScale":1} | wavelength 64 … 20000 |  | climate | Weirdness: Ridges at \|W\| = 2/3 via PV; sign selects variants. |
| `climate.T` | noise | {"amplitudes":null,"clampSigma":3,"double":true,"lacunarity":2,"octaves":4,"persistence":0.5,"remap":"uniform","wavelength":5000,"yScale":1} | wavelength 64 … 20000 |  | climate | Temperature: Cold ↔ hot; zones about twice the size of humidity zones. |
| `climate.H` | noise | {"amplitudes":null,"clampSigma":3,"double":true,"lacunarity":2,"octaves":4,"persistence":0.5,"remap":"uniform","wavelength":2400,"yScale":1} | wavelength 64 … 20000 |  | climate | Humidity: Dry ↔ wet. |
| `climate.R` | noise | {"amplitudes":null,"clampSigma":3,"double":true,"lacunarity":2,"octaves":4,"persistence":0.5,"remap":"uniform","wavelength":1000,"yScale":1} | wavelength 64 … 20000 |  | climate | Rivers: Its zero set gives the river lines. |
| `shape.offset` | spline | {"coord":"C","points":[{"d":0,"x":-1,"y":16},{"d":38.8888888888889,"x":-0.6,"y":26},{"d":72.5063938618926,"x":-0.4,"y":40},{"d":87.0967741935484,"x":-0.24,"y":52},{"d":0,"x":-0.16,"y":60},{"d":0,"x":-0.1,"y":{"coord":"E","points":[{"d":-8.5,"x":-1,"y":70},{"d":-1.71428571428571,"x":0,"y":64},{"d":0,"x":1,"y":63}]}},{"d":0,"x":0.05,"y":{"coord":"E","points":[{"d":0,"x":-1,"y":{"coord":"PV","points":[{"d":19,"x":-1,"y":72},{"d":28.1379310344828,"x":0,"y":96},{"d":39,"x":1,"y":130}]}},{"d":0,"x":-0.4,"y":{"coord":"PV","points":[{"d":12,"x":-1,"y":68},{"d":15.75,"x":0,"y":82},{"d":20,"x":1,"y":100}]}},{"d":0,"x":0.2,"y":{"coord":"PV","points":[{"d":11,"x":-1,"y":72},{"d":12.9230769230769,"x":0,"y":84},{"d":15,"x":1,"y":98}]}},{"d":0,"x":1,"y":76}]}},{"d":0,"x":0.3,"y":{"coord":"E","points":[{"d":0,"x":-1,"y":{"coord":"PV","points":[{"d":42.5,"x":-1,"y":80},{"d":47.3684210526316,"x":0,"y":125},{"d":52.5,"x":1,"y":175}]}},{"d":0,"x":-0.4,"y":{"coord":"PV","points":[{"d":16,"x":-1,"y":72},{"d":23.3333333333333,"x":0,"y":92},{"d":32,"x":1,"y":120}]}},{"d":0,"x":0.2,"y":{"coord":"PV","points":[{"d":13,"x":-1,"y":78},{"d":14.9333333333333,"x":0,"y":92},{"d":17,"x":1,"y":108}]}},{"d":0,"x":0.6,"y":90},{"d":-10,"x":1,"y":86}]}},{"d":0,"x":0.6,"y":{"coord":"E","points":[{"d":0,"x":-1,"y":{"coord":"PV","points":[{"d":60,"x":-1,"y":90},{"d":60,"x":0,"y":150},{"d":60,"x":1,"y":210}]}},{"d":0,"x":-0.4,"y":{"coord":"PV","points":[{"d":24,"x":-1,"y":76},{"d":31.5,"x":0,"y":104},{"d":40,"x":1,"y":140}]}},{"d":0,"x":0.2,"y":{"coord":"PV","points":[{"d":17,"x":-1,"y":86},{"d":18.9473684210526,"x":0,"y":104},{"d":21,"x":1,"y":124}]}},{"d":0,"x":1,"y":102}]}}]} | -64 … 320 | blocks | terrain | Offset: Target surface y in blocks from C → E → PV. |
| `shape.sigma` | spline | {"coord":"C","points":[{"d":0,"x":-1,"y":3},{"d":0,"x":-0.16,"y":3},{"d":0,"x":-0.1,"y":1.5},{"d":0,"x":0.05,"y":{"coord":"E","points":[{"d":0,"x":-1,"y":{"coord":"PV","points":[{"d":7,"x":-1,"y":12},{"d":7,"x":1,"y":26}]}},{"d":0,"x":0,"y":6},{"d":-3,"x":1,"y":3}]}}]} | -16 … 64 | blocks | terrain | Sigma: Sd of the 3D surface displacement in blocks (clamped at 0). |
| `shape.jag` | spline | {"coord":"C","points":[{"d":0,"x":-0.1,"y":0},{"d":0,"x":0.05,"y":{"coord":"E","points":[{"d":0,"x":-1,"y":{"coord":"PV","points":[{"d":0,"x":0.3,"y":0},{"d":79.1457286432161,"x":0.7,"y":30},{"d":86.9047619047619,"x":1,"y":55}]}},{"d":0,"x":-0.5,"y":{"coord":"PV","points":[{"d":0,"x":0.3,"y":0},{"d":79.1457286432161,"x":0.7,"y":30},{"d":86.9047619047619,"x":1,"y":55}]}},{"d":0,"x":-0.4,"y":0}]}}]} | -16 … 128 | blocks | terrain | Jaggedness: Amplitude of ridged peaks in blocks (clamped at 0). |
| `rivers.widthMin` | number | 8 | 1 … 64 | blocks | terrain | Minimum width: Channel width where the width noise is lowest. |
| `rivers.widthVar` | number | 12 | 0 … 64 | blocks | terrain | Width variation: Extra channel width where the width noise is highest. |
| `rivers.widthNoise` | noise | {"amplitudes":null,"clampSigma":3,"double":true,"lacunarity":2,"octaves":2,"persistence":0.5,"remap":"uniform","wavelength":600,"yScale":1} | wavelength 16 … 8192 |  | terrain | Width noise: Uniform noise u2 that varies the width and depth along the river. |
| `rivers.valleyBase` | number | 30 | 0 … 400 | blocks | terrain | Valley width: Valley half-width on flat ground (E = −1). |
| `rivers.valleyPerE` | number | 45 | 0 … 400 | blocks | terrain | Valley width per E: Extra valley half-width per unit of (1 + E). |
| `rivers.valleyFloor` | number | 64 | 63 … 128 | blocks | terrain | Valley floor: Height the valley floor starts from next to the channel. |
| `rivers.valleyRise` | number | 2 | 0 … 64 | blocks | terrain | Valley rise: Rise of the valley floor across the valley. |
| `rivers.coastFadeLo` | number | -0.12 | -1 … 1 |  | terrain | Coast fade start: C where valleys begin to fade in from the coast. |
| `rivers.coastFadeHi` | number | -0.02 | -1 … 1 |  | terrain | Coast fade end: C where valleys reach full strength. |
| `rivers.altFadeLo` | number | 120 | 64 … 320 | blocks | terrain | Gorge start: offset0 where channels begin to fade into dry gorges. |
| `rivers.altFadeHi` | number | 170 | 64 … 320 | blocks | terrain | Gorge end: offset0 above which the channel is fully faded. |
| `rivers.depthMin` | number | 3 | 0 … 32 | blocks | terrain | Channel depth: Channel depth below sea level at the centre where u2 is lowest. |
| `rivers.depthVar` | number | 3 | 0 … 32 | blocks | terrain | Channel depth variation: Extra channel depth where u2 is highest. |
| `rivers.wetMargin` | number | 2 | 0 … 16 | blocks | terrain | Wet margin: Blocks beyond the channel edge still counted as river water. |
| `rivers.gorgeDepth` | number | 12 | 0 … 64 | blocks | terrain | Gorge depth: Depth of the dry gorge cut below offset0 on high ground (SP2a amendment). |
| `lakes.cell` | number | 320 | 64 … 4096 | blocks | terrain | Cell size: Voronoi cell size. |
| `lakes.jitter` | number | 0.8 | 0 … 1 |  | terrain | Cell jitter: Fraction of the cell a centre may move from the cell middle. |
| `lakes.warpAmp` | number | 80 | 0 … 1000 | blocks | terrain | Warp amplitude: Displacement of the Voronoi domain. |
| `lakes.warpNoise` | noise | {"amplitudes":null,"clampSigma":3,"double":true,"lacunarity":2,"octaves":2,"persistence":0.5,"remap":"none","wavelength":360,"yScale":1} | wavelength 16 … 8192 |  | terrain | Warp noise: Noise sampled twice (.x and .z) to warp the cells. |
| `lakes.p` | number | 0.12 | 0 … 1 |  | terrain | Probability: Chance that an eligible cell holds a lake. |
| `lakes.minC` | number | -0.1 | -1 … 1 |  | terrain | Minimum C: Continentalness a lake centre needs. |
| `lakes.offsetMin` | number | 66 | -64 … 320 | blocks | terrain | Lowest centre: Lowest offset0 at a lake centre. |
| `lakes.offsetMax` | number | 200 | -64 … 320 | blocks | terrain | Highest centre: Highest offset0 at a lake centre. |
| `lakes.radius` | number | 90 | 8 … 1024 | blocks | terrain | Radius: Basin radius around the cell centre. |
| `lakes.rimWidth` | number | 0.35 | 0.05 … 2 |  | terrain | Rim width: Rim band width as a fraction of the radius. |
| `lakes.roughness` | number | 0.15 | 0 … 1 |  | terrain | Shore roughness: Scale of the rim noise on the basin edge, in radii. |
| `lakes.rimNoise` | noise | {"amplitudes":null,"clampSigma":3,"double":true,"lacunarity":2,"octaves":2,"persistence":0.5,"remap":"none","wavelength":48,"yScale":1} | wavelength 16 … 8192 |  | terrain | Rim noise: Noise that roughens the shoreline. |
| `lakes.ringFrac` | number | 0.55 | 0.1 … 1.5 |  | terrain | Level ring: Radius fraction of the 8 samples that fix the water level. |
| `lakes.depthMin` | number | 4 | 1 … 64 | blocks | terrain | Depth: Lake depth where the depth hash is lowest. |
| `lakes.depthVar` | number | 10 | 0 … 64 | blocks | terrain | Depth variation: Extra depth where the depth hash is highest. |
| `lakes.rimRise` | number | 2 | 0 … 32 | blocks | terrain | Rim rise: Rim height above the water level before the σ margin. |
| `lakes.rimSigma` | number | 0.5 | 0 … 8 | blocks | terrain | Rim sigma: Largest σ on the rim; the rim adds 3 of these above the water. |
| `lakes.sigmaMul` | number | 0.3 | 0 … 1 |  | terrain | Basin sigma: Multiplier of σ inside the basin. |
| `biomes.table` | boxTable | 26 rows | deep_ocean / ocean / warm_ocean / frozen_ocean / beach / snowy_beach / stony_shore / plains / meadow / forest / birch_forest / dark_forest / taiga / snowy_taiga / snowy_plains / desert / savanna / swamp / jungle / badlands / windswept_hills / snowy_slopes / stony_peaks / jagged_peaks / frozen_peaks / volcano |  | terrain | Biome boxes: Climate box, sign(W) filter and tie-break priority of every box-picked surface biome. |
| `biomes.zoomJitter` | number | 1.5 | 0 … 2 | blocks | terrain | Zoom jitter: Jitter of the quart centres in the jittered-Voronoi zoom. |
| `density.noises.jag` | noise | {"amplitudes":null,"clampSigma":3,"double":true,"lacunarity":2,"octaves":2,"persistence":0.5,"remap":"none","wavelength":28,"yScale":1} | wavelength 16 … 8192 |  | terrain | Jag noise: Ridges of jagged peaks: J = (1 − \|z / clampSigma\|)², times the jag spline. |
| `density.noises.overhang` | noise | {"amplitudes":null,"clampSigma":3,"double":true,"lacunarity":2,"octaves":2,"persistence":0.65,"remap":"none","wavelength":32,"yScale":1} | wavelength 16 … 8192 |  | terrain | Overhang noise: 3D surface displacement, times σ and the vertical slide (yScale 1: octaves at λy 32 and 16). |
| `density.noises.detail` | noise | {"amplitudes":null,"clampSigma":3,"double":true,"lacunarity":2,"octaves":1,"persistence":0.5,"remap":"none","wavelength":10,"yScale":1} | wavelength 4 … 256 |  | terrain | Detail noise: Small 3D surface detail outside the interpolation, times the detail amplitude. |
| `density.detailAmpLo` | number | 0.6 | 0 … 8 | blocks | terrain | Detail amplitude at E −1: Detail amplitude in blocks where E ≤ −1. |
| `density.detailAmpHi` | number | 1.5 | 0 … 8 | blocks | terrain | Detail amplitude at E +1: Detail amplitude in blocks where E ≥ 1; linear in (E + 1) / 2 between the two. |
<!-- params:end -->

## Requirements

The app needs cross-origin isolation (COOP/COEP) for SharedArrayBuffer, which browsers only grant in a secure context: open it through `http://localhost:<port>` or HTTPS.
