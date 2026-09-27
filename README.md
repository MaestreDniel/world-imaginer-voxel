# world-imaginer-voxel

A Minecraft-inspired procedural voxel world for the browser: an explorer **and** editor (break/place blocks, real flowing water), built with TypeScript, Vite and three.js (WebGL2, custom GLSL3 shaders).

It is the successor of [world-imaginer](https://github.com/MaestreDniel/world-imaginer), a research repository whose projects 01-09 explored noise, heightmaps, biomes, splines and density terrain. This repository starts from a clean scaffold and a measured diagnosis of `09-density-terrain`.

## Status

SP0 (scaffold, guardrails, CI) is complete: the app shows a sky canvas and a capability report, deployed at https://world-imaginer-voxel.vercel.app. SP1 (deterministic math core) is next.

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

## Requirements

The app needs cross-origin isolation (COOP/COEP) for SharedArrayBuffer, which browsers only grant in a secure context: open it through `http://localhost:<port>` or HTTPS.
