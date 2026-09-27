# world-imaginer-voxel

A Minecraft-inspired procedural voxel world for the browser: an explorer **and** editor (break/place blocks, real flowing water), built with TypeScript, Vite and three.js (WebGL2, custom GLSL3 shaders).

It is the successor of [world-imaginer](https://github.com/MaestreDniel/world-imaginer), a research repository whose projects 01-09 explored noise, heightmaps, biomes, splines and density terrain. This repository starts from a clean scaffold and a measured diagnosis of `09-density-terrain`.

## Status

SP0 (scaffold, guardrails, CI) is complete: the app shows a sky canvas and a capability report, deployed at https://world-imaginer-voxel.vercel.app. SP1 (deterministic math core, with the `?lab=noise` page that inspects every climate noise) is implemented on branch `sp1/math-core`; its exit is pending CI and the Chrome/Firefox determinism check. SP2 (column stage, 2D biomes, map and parameter tooling) comes next.

## Development

```bash
npm install
npm run dev            # http://localhost:5183 (must be localhost or HTTPS)
npm run build          # typecheck + production build
npm test               # unit + arch + fast metrics
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
| `climate.R` | noise | {"amplitudes":null,"clampSigma":3,"double":true,"lacunarity":2,"octaves":4,"persistence":0.5,"remap":"uniform","wavelength":1400,"yScale":1} | wavelength 64 … 20000 |  | climate | Rivers: Its zero set gives the river lines. |
<!-- params:end -->

## Requirements

The app needs cross-origin isolation (COOP/COEP) for SharedArrayBuffer, which browsers only grant in a secure context: open it through `http://localhost:<port>` or HTTPS.
