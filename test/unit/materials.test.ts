import { createHash } from 'node:crypto';
import v8 from 'node:v8';
import { runInNewContext } from 'node:vm';
import { AdditiveBlending, Color, DoubleSide, GLSL3, NoColorSpace, SRGBColorSpace, type ShaderMaterial } from 'three';
import { describe, expect, test } from 'vitest';
import { skyColors, sunDirection } from '../../src/daynight/dayNight';
import { FLUID_FOG_GLSL, FOG_GLSL } from '../../src/render/materials/glsl/common.glsl';
import { LAVA_LAYER } from '../../src/mesh/greedy';
import { packingGlsl } from '../../src/render/materials/glsl/packing.glsl';
import { GHOST_LIGHT_FLOOR, glslFloat, TERRAIN_FRAGMENT, terrainVertex } from '../../src/render/materials/glsl/terrain.glsl';
import { createMaterialSystem, fogRange, type MaterialSystem, type MaterialVariant } from '../../src/render/materials/index';
import { GHOST_ALPHA } from '../../src/render/materials/uniforms';
import { XRAY_BIOME_COLORS, XRAY_COLORS } from '../../src/render/xrayPalette';
import { FACE_DOWN, FACE_EAST, FACE_NORTH, FACE_SOUTH, FACE_UP, FACE_WEST } from '../../src/world/blocks/kinds';
import type { FrameState } from '../../src/render/frameState';
import { createFlatColorArray } from '../../src/render/textureArray';
import {
  FLUID_FOG_L_LAVA, FLUID_FOG_L_WATER, FLUID_FOG_SHARPNESS, FLUID_FOG_TINT,
} from '../../src/render/fogMath';
import { allocationOver, expectAtRest, N } from './fixtures/heapGrowth';

const ALBEDO = createFlatColorArray();
const system = (variant: MaterialVariant, ao = true, smoothLight = true): MaterialSystem =>
  createMaterialSystem({ variant, ao, smoothLight }, ALBEDO);
const SYSTEMS = { batch: system('batch'), mesh: system('mesh') } as const;
const VARIANTS = ['batch', 'mesh'] as const;

const all = (m: MaterialSystem): Record<string, ShaderMaterial> => ({
  terrainOpaque: m.terrainOpaque, terrainCutout: m.terrainCutout, water: m.water, sky: m.sky, decodeDebug: m.decodeDebug,
  ghost: m.ghost, xray: m.xray,
});
/** The terrain and water materials: the ones with a batched and a RegionMesh variant. */
const terrainAndWater = (m: MaterialSystem): ShaderMaterial[] => [m.terrainOpaque, m.terrainCutout, m.water];

const FRAME: FrameState = { t: 1 / 12, brightness: 0.3, eyeSky: 15, rd: 12, fogBand: 64, nightVision: 0, seconds: 0, eyeFluid: 0 };

/** The index of the `#endif` that closes the conditional block opened at `start` (nested blocks skipped). */
function blockEnd(src: string, start: number): number {
  const directive = /^\s*#(if|ifdef|ifndef|endif)\b/gm;
  directive.lastIndex = start;
  let depth = 0;
  for (let m = directive.exec(src); m; m = directive.exec(src)) {
    depth += m[1] === 'endif' ? -1 : 1;
    if (depth === 0) return m.index + m[0].indexOf('#');
  }
  return -1;
}

/**
 * `src` as the preprocessor sees it with `GHOST` defined or not: the `#ifdef GHOST` / `#ifndef GHOST` blocks resolved
 * (their `#else` honoured) and their directive lines dropped; every other line, directives included, kept as written.
 */
function resolveGhost(src: string, ghost: boolean): string {
  const frames: Array<{ ghost: boolean; on: boolean }> = [];
  const out: string[] = [];
  for (const line of src.split('\n')) {
    const d = /^\s*#(\w+)\s*(\w*)/.exec(line);
    const kind = d?.[1];
    if (kind === 'ifdef' || kind === 'ifndef' || kind === 'if') {
      const isGhost = kind !== 'if' && d![2] === 'GHOST';
      frames.push({ ghost: isGhost, on: !isGhost || (kind === 'ifdef') === ghost });
      if (isGhost) continue;
    } else if (kind === 'else' || kind === 'elif' || kind === 'endif') {
      const top = frames[frames.length - 1]!;
      if (kind === 'endif') frames.pop();
      if (top.ghost) {
        expect(kind, 'no #elif in a GHOST block').not.toBe('elif');
        if (kind === 'else') top.on = !top.on;
        continue;
      }
    }
    if (frames.every((f) => f.on)) out.push(line);
  }
  expect(frames, 'every conditional block is closed').toEqual([]);
  return out.join('\n');
}

/** SHA-256 and length of `TERRAIN_FRAGMENT` before SP5c's ghost (SP5a's, at 37ebbb1). */
const SP5A_TERRAIN_FRAGMENT = { sha256: 'cd91f3ef8ae9954e51b46c26a51b63e9e60b8882298b7b46704a9b590d7c8285', length: 2375 };

describe('materials v1 (SP4a spec §6.4-§6.6)', () => {
  test('every material is a GLSL3 ShaderMaterial', () => {
    for (const v of VARIANTS) {
      for (const [name, m] of Object.entries(all(SYSTEMS[v]))) {
        expect(m.glslVersion, `${v} ${name}`).toBe(GLSL3);
        expect(m.isShaderMaterial, `${v} ${name}`).toBe(true);
      }
      expect(SYSTEMS[v].variant).toBe(v);
    }
  });

  test('batch terrain and water vertex shaders contain both batching includes; mesh ones #define REGION_MESH and neither', () => {
    for (const m of terrainAndWater(SYSTEMS.batch)) {
      expect(m.vertexShader).toContain('#include <batching_pars_vertex>');
      expect(m.vertexShader).toContain('#include <batching_vertex>');
      expect(m.vertexShader).not.toContain('#define REGION_MESH');
    }
    for (const m of terrainAndWater(SYSTEMS.mesh)) {
      expect(m.vertexShader).toContain('#define REGION_MESH');
      expect(m.vertexShader).not.toContain('batching_pars_vertex');
      expect(m.vertexShader).not.toContain('batching_vertex');
    }
  });

  test('terrain and water fragments contain the colour-space chunk and length(viewPos); decodeDebug has no colour-space chunk', () => {
    for (const v of VARIANTS) {
      for (const m of terrainAndWater(SYSTEMS[v])) {
        expect(m.fragmentShader).toContain('#include <colorspace_fragment>');
        expect(m.fragmentShader).toContain('length(viewPos)');
      }
      expect(SYSTEMS[v].decodeDebug.fragmentShader).not.toContain('colorspace_fragment');
      expect(SYSTEMS[v].decodeDebug.fragmentShader).not.toContain('linearToOutputTexel');
    }
  });

  test('every fragment shader declares pc_fragColor (ruling P14)', () => {
    for (const v of VARIANTS) {
      for (const [name, m] of Object.entries(all(SYSTEMS[v]))) {
        expect(m.fragmentShader, `${v} ${name}`).toContain('layout(location = 0) out highp vec4 pc_fragColor;');
      }
    }
  });

  test('terrain and water define gl_FragColor as pc_fragColor before the colour-space chunk (ruling P14)', () => {
    for (const v of VARIANTS) {
      for (const m of terrainAndWater(SYSTEMS[v])) {
        const define = m.fragmentShader.indexOf('#define gl_FragColor pc_fragColor');
        expect(define).toBeGreaterThanOrEqual(0);
        expect(define).toBeLessThan(m.fragmentShader.indexOf('#include <colorspace_fragment>'));
      }
    }
  });

  test('terrain and water look the lightmap up through lightmapAt, the fog at (block 0, eyeSky) (ruling P15)', () => {
    for (const v of VARIANTS) {
      for (const m of terrainAndWater(SYSTEMS[v])) {
        expect(m.fragmentShader).toContain('lightmapAt(');
        expect(m.fragmentShader).toContain('lightmapAt(0.0, eyeSky)');
        expect(m.fragmentShader).toContain('vec3 lightmapAt(float block, float sky)');
        expect(m.fragmentShader).toContain('texture(lightmap, (vec2(block, sky) + 0.5) / 16.0).rgb');
      }
    }
  });

  test('the fog colour is the sky gradient towards the horizon, without the sun disc or glow (final review B-M1)', () => {
    for (const v of VARIANTS) {
      for (const m of terrainAndWater(SYSTEMS[v])) {
        const src = m.fragmentShader;
        const fog = src.slice(src.indexOf('vec3 applyFog('), src.indexOf('\n}', src.indexOf('vec3 applyFog(')));
        expect(fog).toContain('vec3 fogColor = skyGradient(horizonDir) * lightmapAt(0.0, eyeSky);');
        expect(fog).not.toContain('skyColor(');
        expect(fog).not.toContain('SUN_');
      }
      // The sky dome keeps the disc and the glow, over the same gradient.
      const sky = SYSTEMS[v].sky.fragmentShader;
      const body = sky.slice(sky.indexOf('vec3 skyColor('), sky.indexOf('\n}', sky.indexOf('vec3 skyColor(')));
      expect(body).toContain('vec3 c = skyGradient(dir);');
      expect(body).toContain('SUN_GLOW_COLOR');
      expect(body).toContain('SUN_COLOR');
    }
  });

  test('every shader that decodes contains packingGlsl() verbatim', () => {
    for (const v of VARIANTS) {
      for (const m of terrainAndWater(SYSTEMS[v])) {
        expect(m.vertexShader).toContain(packingGlsl());
        expect(m.vertexShader).toContain('in uint data;');
      }
    }
  });

  test('the water material is transparent, writes depth, is double-sided, and its alpha uniform is 0.72', () => {
    for (const v of VARIANTS) {
      const w = SYSTEMS[v].water;
      expect(w.transparent).toBe(true);
      expect(w.depthWrite).toBe(true);
      expect(w.side).toBe(DoubleSide);
      expect(w.uniforms['alpha']!.value).toBe(0.72);
      expect(w.vertexShader).toContain('cornerDrop');
    }
  });

  test('the water colours are the sRGB shallow and deep colours converted to linear on the CPU', () => {
    const w = SYSTEMS.batch.water;
    const linear = (r: number, g: number, b: number) => new Color().setRGB(r / 255, g / 255, b / 255, SRGBColorSpace);
    expect((w.uniforms['waterShallow']!.value as Color).equals(linear(64, 128, 230))).toBe(true);
    expect((w.uniforms['waterDeep']!.value as Color).equals(linear(16, 40, 96))).toBe(true);
    expect((w.uniforms['waterShallow']!.value as Color).r).toBeLessThan(64 / 255);
  });

  test('the sky writes no depth and sits at the far plane; the cutout pass is double-sided', () => {
    for (const v of VARIANTS) {
      const m = SYSTEMS[v];
      expect(m.sky.depthWrite).toBe(false);
      expect(m.sky.vertexShader).toContain('gl_Position = vec4(position.xy, 1.0, 1.0)');
      expect(m.terrainCutout.side).toBe(DoubleSide);
      expect(m.terrainCutout.defines['CUTOUT']).toBeDefined();
      expect(m.terrainOpaque.defines['CUTOUT']).toBeUndefined();
    }
  });

  test('ao and smoothLight become defines of the terrain and water materials', () => {
    const on = system('batch', true, true);
    const off = system('batch', false, false);
    expect(on.terrainOpaque.defines['TERRAIN_AO']).toBeDefined();
    expect(on.terrainOpaque.defines['SMOOTH_LIGHT']).toBeDefined();
    expect(on.water.defines['SMOOTH_LIGHT']).toBeDefined();
    expect(off.terrainOpaque.defines['TERRAIN_AO']).toBeUndefined();
    expect(off.terrainOpaque.defines['SMOOTH_LIGHT']).toBeUndefined();
    expect(off.water.defines['SMOOTH_LIGHT']).toBeUndefined();
  });

  test('fogRange: end (rd − 1)·16, start 64 blocks before, never below 0, written into out (SP4b spec §6.3, D17)', () => {
    const out = { start: -1, end: -1 };
    expect(fogRange(12, 64, out)).toBe(out);
    expect(out).toEqual({ start: 112, end: 176 });
    expect(fogRange(8, 64, out)).toEqual({ start: 48, end: 112 });
    expect(fogRange(4, 64, out)).toEqual({ start: 0, end: 48 });
  });

  test('setFrameUniforms at rd 12: the fog spans 112-176; no edge, edgeFadeStart or edgeCentre uniform on any material', () => {
    const m = system('batch');
    m.setFrameUniforms(FRAME);
    const u = m.terrainOpaque.uniforms;
    expect(u['fogStart']!.value).toBe(112);
    expect(u['fogEnd']!.value).toBe(176);
    for (const v of VARIANTS) {
      for (const [name, mat] of Object.entries(all(SYSTEMS[v]))) {
        for (const gone of ['edge', 'edgeFadeStart', 'edgeCentre']) expect(mat.uniforms[gone], `${v} ${name} ${gone}`).toBeUndefined();
      }
    }
  });

  test('the GLSL has no edge term (SP4b spec §6.2)', () => {
    const at = FOG_GLSL.indexOf('vec3 applyFog(');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(FOG_GLSL).not.toContain('edge');
    for (const v of VARIANTS) {
      for (const [name, mat] of Object.entries(all(SYSTEMS[v]))) {
        expect(mat.vertexShader + mat.fragmentShader, `${v} ${name}`).not.toMatch(/edge/i);
      }
    }
  });

  test('setFrameUniforms({ …, eyeSky: 7 }) sets the eyeSky uniform to 7 (ruling P15)', () => {
    const m = system('mesh');
    m.setFrameUniforms({ ...FRAME, eyeSky: 7 });
    expect(m.terrainOpaque.uniforms['eyeSky']!.value).toBe(7);
    expect(m.water.uniforms['eyeSky']!.value).toBe(7);
  });

  test('every material shares one uniform object per name, so one update reaches all of them', () => {
    const m = system('batch');
    for (const name of ['lightmap', 'fogStart', 'fogEnd', 'eyeSky', 'skyZenith', 'skyHorizon', 'sunDir']) {
      expect(m.water.uniforms[name], name).toBe(m.terrainOpaque.uniforms[name]);
      expect(m.terrainCutout.uniforms[name], name).toBe(m.terrainOpaque.uniforms[name]);
    }
    for (const name of ['skyZenith', 'skyHorizon', 'sunDir']) expect(m.sky.uniforms[name], name).toBe(m.terrainOpaque.uniforms[name]);
    expect(m.water.uniforms['albedo']).toBeUndefined();
    expect(m.terrainCutout.uniforms['albedo']).toBe(m.terrainOpaque.uniforms['albedo']);
  });

  test('setFrameUniforms writes the sky stops in linear and the sun direction of t', () => {
    const m = system('batch');
    const t = 0.4;
    m.setFrameUniforms({ ...FRAME, t });
    const { zenith, horizon } = skyColors(t);
    const u = m.sky.uniforms;
    expect((u['skyZenith']!.value as Color).equals(new Color().setRGB(...zenith, SRGBColorSpace))).toBe(true);
    expect((u['skyHorizon']!.value as Color).equals(new Color().setRGB(...horizon, SRGBColorSpace))).toBe(true);
    const sun = sunDirection(t);
    expect(u['sunDir']!.value.toArray().map((x: number, i: number) => x - sun[i]!).every((d: number) => Math.abs(d) < 1e-12)).toBe(true);
  });

  test('setFrameUniforms rebuilds the lightmap only when the time or the brightness changes', () => {
    const m = system('batch');
    const tex = m.lightmap.texture;
    m.setFrameUniforms(FRAME);
    const v1 = tex.version;
    const noon = Array.from(tex.image.data as Uint8Array);
    m.setFrameUniforms(FRAME);
    expect(tex.version).toBe(v1);
    m.setFrameUniforms({ ...FRAME, t: 0.75 });
    expect(tex.version).toBeGreaterThan(v1);
    expect(Array.from(tex.image.data as Uint8Array)).not.toEqual(noon);
    const v2 = tex.version;
    m.setFrameUniforms({ ...FRAME, t: 0.75, brightness: 1 });
    expect(tex.version).toBeGreaterThan(v2);
  });

  test('the albedo uniform keeps SRGBColorSpace and the lightmap NoColorSpace', () => {
    for (const v of VARIANTS) {
      const u = SYSTEMS[v].terrainOpaque.uniforms;
      expect(u['albedo']!.value).toBe(ALBEDO);
      expect(u['albedo']!.value.colorSpace).toBe(SRGBColorSpace);
      expect(u['lightmap']!.value).toBe(SYSTEMS[v].lightmap.texture);
      expect(u['lightmap']!.value.colorSpace).toBe(NoColorSpace);
    }
  });

  test('the face shade follows kinds.ts face ids: N/S 0.8, E/W 0.6, up 1, down 0.5', () => {
    expect(SYSTEMS.batch.terrainOpaque.fragmentShader).toContain('const float FACE_SHADE[6] = float[6](0.8, 0.6, 0.8, 0.6, 1.0, 0.5);');
    expect(SYSTEMS.batch.terrainOpaque.vertexShader).toContain('const float AO_FACTOR[4] = float[4](1.0, 0.8, 0.6, 0.45);');
  });

  test('the terrain shaders unpack frame (the generated unpack names it) and the fragment GLSL contains the frame discard on vFrame under CUTOUT', () => {
    expect(packingGlsl()).toContain('uint pkS_frame(uint d) { return (d >> PK_S_FRAME_OFFSET) & PK_S_FRAME_MASK; }');
    for (const v of VARIANTS) {
      for (const m of [SYSTEMS[v].terrainOpaque, SYSTEMS[v].terrainCutout]) {
        expect(m.vertexShader).toContain('flat out uint vFrame;');
        expect(m.vertexShader).toContain('vFrame = pkS_frame(data);');
        const src = m.fragmentShader;
        expect(src).toContain('flat in uint vFrame;');
        const start = src.indexOf('#ifdef CUTOUT');
        const cutout = src.slice(start, blockEnd(src, start));
        expect(cutout).toContain('if (base.a < 0.5) discard;');
        expect(cutout).toContain('if (vFrame != 0u) {');
        // The two in-face coordinates of the block-aligned world position (the floating origin is a multiple of 512).
        expect(cutout).toContain('vec3 cell = fract(vWorldPos);');
        expect(cutout).toContain('vec2 inFace = vFace == 4u || vFace == 5u ? cell.xz : vFace == 1u || vFace == 3u ? cell.zy : cell.xy;');
        expect(cutout).toContain('if (all(greaterThanEqual(inFace, vec2(0.0625))) && all(lessThanEqual(inFace, vec2(0.9375)))) discard;');
        expect(src.indexOf('vFrame != 0u')).toBe(src.lastIndexOf('vFrame != 0u'));
      }
    }
  });

  test('lava (SP7a spec §6.3, D26): the terrain vertex shader lowers a vertex by flags · 8/9 only under the LAVA_LAYER test, as the water shader by cornerDrop', () => {
    expect(LAVA_LAYER).toBe(66);
    const lower = `if (pkS_layer(data) == ${LAVA_LAYER}u) p.y -= float(pkS_flags(data)) * (8.0 / 9.0);`;
    for (const v of VARIANTS) {
      expect(terrainVertex(v)).toContain(lower);
      for (const m of [SYSTEMS[v].terrainOpaque, SYSTEMS[v].terrainCutout, SYSTEMS[v].ghost]) {
        const src = m.vertexShader;
        // The one subtraction, under the layer test, before the placement reads p.
        expect(src.split('* (8.0 / 9.0)')).toHaveLength(2);
        expect(src.split('pkS_flags(data)')).toHaveLength(2);
        const at = src.indexOf(lower);
        expect(at).toBeGreaterThan(src.indexOf('vec3 p = position;'));
        expect(src.indexOf('vec4 local = vec4(p, 1.0);')).toBeGreaterThan(at);
        expect(src).not.toContain('vec4 local = vec4(position, 1.0);');
      }
      // The water shader keeps its own drop, the decode-debug shader none.
      expect(SYSTEMS[v].water.vertexShader).toContain('vec3 p = vec3(position.x, position.y - cornerDrop * (8.0 / 9.0), position.z);');
      expect(SYSTEMS[v].decodeDebug.vertexShader).not.toContain('8.0 / 9.0');
    }
  });

  test('dispose frees every material and the lightmap, not the albedo it was given', () => {
    const m = system('mesh');
    const disposed: string[] = [];
    for (const [name, mat] of Object.entries(all(m))) mat.addEventListener('dispose', () => disposed.push(name));
    m.lightmap.texture.addEventListener('dispose', () => disposed.push('lightmap'));
    ALBEDO.addEventListener('dispose', () => disposed.push('albedo'));
    m.dispose();
    expect(disposed.sort()).toEqual(['decodeDebug', 'ghost', 'lightmap', 'sky', 'terrainCutout', 'terrainOpaque', 'water', 'xray']);
  });
});

describe('the ghost material (SP5c spec §6.2, D25)', () => {
  test('the ghost material: defines CUTOUT and GHOST, transparent, depthWrite false, depthTest true, uniforms ghostAlpha 0.45 and ghostTurns 0, in both variants', () => {
    expect(GHOST_ALPHA).toBe(0.45);
    for (const v of VARIANTS) {
      const m = SYSTEMS[v];
      const g = m.ghost;
      expect(g.name).toBe('ghost');
      expect(g.defines['CUTOUT'], v).toBeDefined();
      expect(g.defines['GHOST'], v).toBeDefined();
      // terrainDefines(): the settings' AO and smooth light, as the cutout terrain's.
      expect(g.defines).toEqual({ ...m.terrainCutout.defines, GHOST: '' });
      expect(g.transparent, v).toBe(true);
      expect(g.depthWrite, v).toBe(false);
      expect(g.depthTest, v).toBe(true);
      expect(g.side, v).toBe(DoubleSide);
      // Ruling P16: one pass of a double-sided transparent material (three draws it back then front otherwise).
      expect(g.forceSinglePass, v).toBe(true);
      expect(g.uniforms['ghostAlpha']!.value, v).toBe(0.45);
      expect(g.uniforms['ghostTurns']!.value, v).toBe(0);
      expect(g.vertexShader, v).toBe(terrainVertex(v));
      expect(g.vertexShader, v).toBe(m.terrainCutout.vertexShader);
      expect(g.fragmentShader, v).toBe(TERRAIN_FRAGMENT);
      // The shared uniforms, so setFrameUniforms reaches the ghost too.
      for (const name of ['albedo', 'lightmap', 'fogStart', 'fogEnd', 'eyeSky', 'skyZenith', 'skyHorizon', 'sunDir']) {
        expect(g.uniforms[name], `${v} ${name}`).toBe(m.terrainOpaque.uniforms[name]);
      }
      // The ghost's own uniforms are not the terrain's.
      expect(m.terrainCutout.uniforms['ghostAlpha']).toBeUndefined();
      expect(m.terrainCutout.uniforms['ghostTurns']).toBeUndefined();
    }
    const off = system('mesh', false, false).ghost;
    expect(off.defines).toEqual({ CUTOUT: '', GHOST: '' });
  });

  test('its fragment source remaps the face before both uses (the glass frame\'s in-face coordinates and FACE_SHADE), writes alpha from ghostAlpha and floors the light at 0.6', () => {
    expect(GHOST_LIGHT_FLOOR).toBe(0.6);
    // North → east → south → west for each clockwise turn: the side faces are 0-3 in that order, up and down above.
    expect([FACE_NORTH, FACE_EAST, FACE_SOUTH, FACE_WEST]).toEqual([0, 1, 2, 3]);
    expect(Math.min(FACE_UP, FACE_DOWN)).toBeGreaterThanOrEqual(4);
    const src = resolveGhost(TERRAIN_FRAGMENT, true);
    expect(src).toContain('uniform float ghostAlpha;');
    expect(src).toContain('uniform uint ghostTurns;');
    const body = src.slice(src.indexOf('void main() {'));
    const remap = '  uint face = vFace < 4u ? (vFace + ghostTurns) % 4u : vFace;';
    const at = body.indexOf(remap);
    expect(at, 'the remap').toBeGreaterThanOrEqual(0);
    const after = body.slice(at + remap.length);
    expect(after, 'no use of the unturned face after the remap').not.toContain('vFace');
    const inFace = after.indexOf('vec2 inFace = face == 4u || face == 5u ? cell.xz : face == 1u || face == 3u ? cell.zy : cell.xy;');
    const shade = after.indexOf('FACE_SHADE[min(face, 5u)]');
    expect(inFace, 'the glass frame reads the turned face').toBeGreaterThanOrEqual(0);
    expect(shade, 'the face shade reads the turned face').toBeGreaterThan(inFace);
    expect(after).toContain('vec3 color = base.rgb * FACE_SHADE[min(face, 5u)] * vAo * max(lightmapAt(vBlock, vSky), vec3(0.6));');
    expect(after).toContain('gl_FragColor = vec4(applyFog(color, vViewPos, vWorldPos), ghostAlpha);');
    expect(after).not.toContain('), 1.0);');
    // Still the cutout: transparent texels and the inside of glass's frame are discarded.
    expect(after).toContain('if (base.a < 0.5) discard;');
    expect(after).toContain('if (all(greaterThanEqual(inFace, vec2(0.0625))) && all(lessThanEqual(inFace, vec2(0.9375)))) discard;');
    // The remap in JS: q clockwise turns take each side face q steps along north → east → south → west.
    const turned = (face: number, q: number): number => (face < 4 ? (face + q) % 4 : face);
    expect(turned(FACE_NORTH, 1)).toBe(FACE_EAST);
    expect(turned(FACE_EAST, 1)).toBe(FACE_SOUTH);
    expect(turned(FACE_WEST, 1)).toBe(FACE_NORTH);
    expect(turned(FACE_SOUTH, 3)).toBe(FACE_EAST);
    expect(turned(FACE_UP, 2)).toBe(FACE_UP);
    expect(turned(FACE_DOWN, 3)).toBe(FACE_DOWN);
  });

  test('the source with GHOST undefined equals today\'s TERRAIN_FRAGMENT (no ghost code outside #ifdef GHOST), so the terrain materials are unchanged', () => {
    const plain = resolveGhost(TERRAIN_FRAGMENT, false);
    // SP7a's fluid fog (its spec §8: FLUID_FOG_GLSL in FOG_GLSL and applyFog's branch) is the one change since SP5a.
    const fluidFog = [FLUID_FOG_GLSL, '  if (eyeFluid > 0.5) return fluidFog(color, length(viewPos));\n'];
    for (const added of fluidFog) expect(plain.split(added), 'SP7a\'s fluid fog, once').toHaveLength(2);
    const sp5a = fluidFog.reduce((src, added) => src.replace(added, ''), plain);
    expect(sp5a.length).toBe(SP5A_TERRAIN_FRAGMENT.length);
    expect(createHash('sha256').update(sp5a).digest('hex')).toBe(SP5A_TERRAIN_FRAGMENT.sha256);
    expect(plain).not.toMatch(/ghost/i);
    expect(plain).not.toContain('uint face');
    expect(TERRAIN_FRAGMENT).toContain('#ifdef GHOST');
    for (const v of VARIANTS) {
      for (const m of [SYSTEMS[v].terrainOpaque, SYSTEMS[v].terrainCutout]) {
        expect(m.fragmentShader).toBe(TERRAIN_FRAGMENT);
        expect(m.defines['GHOST']).toBeUndefined();
      }
    }
  });

  test('setGhostTurns(3) writes 3; dispose frees the ghost material', () => {
    const m = system('batch');
    const turns = m.ghost.uniforms['ghostTurns']!;
    m.setGhostTurns(3);
    expect(turns.value).toBe(3);
    expect(m.ghost.uniforms['ghostTurns']).toBe(turns);
    m.setGhostTurns(0);
    expect(turns.value).toBe(0);
    let freed = 0;
    m.ghost.addEventListener('dispose', () => freed++);
    m.dispose();
    expect(freed).toBe(1);
  });
});

describe('the X-ray material and the collapse uniform (SP6a spec §5.2, §5.3)', () => {
  /** `src` from `void main() {` on. */
  const mainOf = (src: string): string => src.slice(src.indexOf('void main() {'));
  /** The block `{ … }` opened by the first `head` in `src` (head included), braces nested. */
  const braceBlock = (src: string, head: string): string => {
    const at = src.indexOf(head);
    expect(at, head).toBeGreaterThanOrEqual(0);
    let depth = 0;
    for (let i = src.indexOf('{', at); i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1);
    }
    throw new Error(`unclosed ${head}`);
  };
  const PLACED = 'gl_Position = projectionMatrix * mvPos4;';

  test('`xray` in both variants: additive, no depth write, no depth test, double-sided in one pass, the variant\'s vertex head', () => {
    for (const v of VARIANTS) {
      const x = SYSTEMS[v].xray;
      expect(x.name, v).toBe('xray');
      expect(x.isShaderMaterial, v).toBe(true);
      expect(x.glslVersion, v).toBe(GLSL3);
      expect(x.blending, v).toBe(AdditiveBlending);
      expect(x.transparent, v).toBe(true);
      expect(x.depthWrite, v).toBe(false);
      expect(x.depthTest, v).toBe(false);
      expect(x.side, v).toBe(DoubleSide);
      expect(x.forceSinglePass, v).toBe(true);
      expect(x.vertexShader, v).toContain(packingGlsl());
      expect(x.vertexShader, v).toContain('vKind = pkX_kind(data);');
      expect(x.vertexShader, v).toContain('vFace = pkX_face(data);');
      expect(x.vertexShader, v).toContain('flat out uint vBiome;');
      expect(x.vertexShader, v).toContain('vBiome = pkX_biome(data);');
    }
    expect(SYSTEMS.mesh.xray.vertexShader).toContain('#define REGION_MESH');
    expect(SYSTEMS.mesh.xray.vertexShader).not.toContain('batching_vertex');
    expect(SYSTEMS.batch.xray.vertexShader).toContain('#include <batching_pars_vertex>');
    expect(SYSTEMS.batch.xray.vertexShader).toContain('#include <batching_vertex>');
    // No light defines: the X-ray reads no light.
    expect(SYSTEMS.batch.xray.defines ?? {}).toEqual({});
  });

  test('its colour is palette[kind] × FACE_SHADE[face], alpha 0.14 for walls and 0.05 for the film, faded to 0 at the fog end; it reads no lightmap', () => {
    for (const v of VARIANTS) {
      const src = SYSTEMS[v].xray.fragmentShader;
      expect(src).toContain('uniform vec3 xrayPalette[16];');
      expect(src).toContain('const float FACE_SHADE[6] = float[6](0.8, 0.6, 0.8, 0.6, 1.0, 0.5);');
      const body = mainOf(src);
      expect(body).toContain('vec3 color = (xrayColorMode > 0.5 && vKind != 15u ? xrayBiomePalette[vBiome] : xrayPalette[vKind]) * FACE_SHADE[min(vFace, 5u)];');
      expect(body).toContain('float alpha = vKind == 15u ? 0.05 : 0.14;');
      expect(body).toContain('float fade = 1.0 - smoothstep(fogStart, fogEnd, dist);');
      expect(body).toContain('gl_FragColor = vec4(color, alpha * fade);');
      expect(body).toContain('#include <colorspace_fragment>');
      expect(src + SYSTEMS[v].xray.vertexShader).not.toMatch(/lightmap|vSky|vBlock/);
      expect(SYSTEMS[v].xray.uniforms['lightmap']).toBeUndefined();
    }
  });

  test('it discards every fragment beyond xrayRadius, and outside the band [xrayYMin, xrayYMax + 1) only for kind ≠ 15 (the film ignores the band)', () => {
    for (const v of VARIANTS) {
      const body = mainOf(SYSTEMS[v].xray.fragmentShader);
      const radius = body.indexOf('if (dist > xrayRadius) discard;');
      expect(radius, 'the radius discard').toBeGreaterThanOrEqual(0);
      const walls = braceBlock(body, 'if (vKind != 15u) {');
      // The band's cell: the hollow voxel's y, a face's plane moved half a block into it (an up face of voxel y lies at
      // y + 1, a down face at y), so a wall's fragments all test their own voxel's y.
      expect(walls).toContain('float cellY = floor(vWorldPos.y - (vFace == 4u ? 0.5 : vFace == 5u ? -0.5 : 0.0));');
      expect(walls).toContain('if (cellY < xrayYMin || cellY >= xrayYMax + 1.0) discard;');
      // Exactly two discards: the radius (every fragment) and the band (walls only).
      expect(body.split('discard').length - 1).toBe(2);
      expect(body.indexOf('xrayYMin')).toBeGreaterThan(body.indexOf('if (vKind != 15u) {'));
      expect(radius).toBeLessThan(body.indexOf('if (vKind != 15u) {'));
    }
  });

  test('the collapse: the X-ray vertex shader collapses while xrayOn is 0; terrain (opaque, cutout) and water while it is 1; the ghost\'s compiled source has no xrayOn branch', () => {
    for (const v of VARIANTS) {
      const m = SYSTEMS[v];
      const collapsed = 'const vec4 COLLAPSED = vec4(0.0, 0.0, 2.0, 1.0);';
      // The X-ray's: after the placement, while off.
      const x = mainOf(m.xray.vertexShader);
      expect(m.xray.vertexShader).toContain('uniform float xrayOn;');
      expect(m.xray.vertexShader).toContain(collapsed);
      expect(x.indexOf('if (xrayOn < 0.5) gl_Position = COLLAPSED;')).toBeGreaterThan(x.indexOf(PLACED));
      // Terrain: under #ifndef GHOST, so the opaque and cutout terrain collapse while on and the ghost never does.
      for (const t of [m.terrainOpaque, m.terrainCutout]) {
        const plain = resolveGhost(t.vertexShader, false);
        expect(plain).toContain('uniform float xrayOn;');
        expect(plain).toContain(collapsed);
        const body = mainOf(plain);
        expect(body.indexOf('if (xrayOn > 0.5) gl_Position = COLLAPSED;')).toBeGreaterThan(body.indexOf(PLACED));
      }
      const ghost = resolveGhost(m.ghost.vertexShader, true);
      expect(ghost).not.toContain('xrayOn');
      expect(ghost).not.toContain('COLLAPSED');
      expect(m.ghost.vertexShader).toContain('#ifndef GHOST');
      expect(m.ghost.uniforms['xrayOn']).toBeUndefined();
      // Water: always (it has no ghost).
      const w = mainOf(m.water.vertexShader);
      expect(m.water.vertexShader).toContain('uniform float xrayOn;');
      expect(w.indexOf('if (xrayOn > 0.5) gl_Position = COLLAPSED;')).toBeGreaterThan(w.indexOf(PLACED));
      // The sky dome and the decode-debug material are not collapsed (the renderer hides the sky).
      for (const o of [m.sky, m.decodeDebug]) expect(o.vertexShader + o.fragmentShader).not.toContain('xrayOn');
    }
  });

  test('xrayOn is one uniform object in terrain, water and the X-ray; the X-ray shares the fog; defaults: off, every depth (−64 … 319); the palette is D10\'s in linear', () => {
    for (const v of VARIANTS) {
      const m = SYSTEMS[v];
      const on = m.xray.uniforms['xrayOn']!;
      for (const t of [m.terrainOpaque, m.terrainCutout, m.water]) expect(t.uniforms['xrayOn']).toBe(on);
      for (const name of ['fogStart', 'fogEnd']) expect(m.xray.uniforms[name], name).toBe(m.terrainOpaque.uniforms[name]);
      const fresh = system(v);
      expect(fresh.xray.uniforms['xrayOn']!.value).toBe(0);
      expect(fresh.xray.uniforms['xrayYMin']!.value).toBe(-64);
      expect(fresh.xray.uniforms['xrayYMax']!.value).toBe(319);
      const palette = m.xray.uniforms['xrayPalette']!.value as Color[];
      expect(palette).toHaveLength(16);
      palette.forEach((c, i) => {
        expect(c.isColor, `kind ${i}`).toBe(true);
        expect(`#${c.getHexString(SRGBColorSpace)}`, `kind ${i}`).toBe(XRAY_COLORS[i]);
      });
      // Stored linear (as every colour uniform): cheese's green 0xb0 converts below 0xb0 / 255.
      expect(palette[1]!.g).toBeLessThan(0xb0 / 255);
    }
  });

  test('by cave biome (SP6b spec §7.2): both variants declare xrayBiomePalette[16] and xrayColorMode; the film keeps its kind\'s colour in either mode; defaults: by kind (0), the palette XRAY_BIOME_COLORS in linear', () => {
    for (const v of VARIANTS) {
      const m = SYSTEMS[v];
      const src = m.xray.fragmentShader;
      expect(src, v).toContain('uniform vec3 xrayBiomePalette[16];');
      expect(src, v).toContain('uniform float xrayColorMode;');
      expect(src, v).toContain('flat in uint vBiome;');
      // One selection, by mode and kind: the walls by biome in mode 1, the film (kind 15) by its kind in both.
      const body = mainOf(src);
      expect(body.split('xrayBiomePalette[').length - 1, v).toBe(1);
      expect(body.split('xrayPalette[').length - 1, v).toBe(1);
      expect(system(v).xray.uniforms['xrayColorMode']!.value, v).toBe(0);
      const palette = m.xray.uniforms['xrayBiomePalette']!.value as Color[];
      expect(palette, v).toHaveLength(16);
      palette.forEach((c, i) => {
        expect(c.isColor, `biome ${i}`).toBe(true);
        expect(`#${c.getHexString(SRGBColorSpace)}`, `biome ${i}`).toBe(XRAY_BIOME_COLORS[i]);
      });
      // Stored linear: lush's red 0x4d converts below 0x4d / 255.
      expect(palette[1]!.r).toBeLessThan(0x4d / 255);
    }
  });

  test('setXrayColorMode(1) writes xrayColorMode 1 and nothing else; setXrayColorMode(0) writes it back to 0', () => {
    const m = system('batch');
    m.setXray(true, -40, -9, 176);
    /** Every uniform of every material by value (colours as hex, vectors as arrays, textures by reference). */
    const snapshot = (): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      for (const [name, mat] of Object.entries(all(m))) {
        for (const [key, u] of Object.entries(mat.uniforms)) {
          const val = u.value as unknown;
          const of = (x: unknown): unknown =>
            x instanceof Color ? x.getHex() : (x as { isVector3?: boolean })?.isVector3 ? (x as { toArray(): number[] }).toArray() : x;
          out[`${name}.${key}`] = Array.isArray(val) ? val.map(of) : of(val);
        }
      }
      return out;
    };
    const before = snapshot();
    m.setXrayColorMode(1);
    const after = snapshot();
    expect(after['xray.xrayColorMode']).toBe(1);
    expect({ ...after, 'xray.xrayColorMode': 0 }).toEqual(before);
    m.setXrayColorMode(0);
    expect(snapshot()).toEqual(before);
  });

  test('setXray writes xrayOn, the band and the radius', () => {
    const m = system('batch');
    const u = m.xray.uniforms;
    m.setXray(true, -40, -9, 176);
    expect([u['xrayOn']!.value, u['xrayYMin']!.value, u['xrayYMax']!.value, u['xrayRadius']!.value]).toEqual([1, -40, -9, 176]);
    expect(m.terrainOpaque.uniforms['xrayOn']!.value).toBe(1);
    m.setXray(false, -64, 319, 112.5);
    expect([u['xrayOn']!.value, u['xrayYMin']!.value, u['xrayYMax']!.value, u['xrayRadius']!.value]).toEqual([0, -64, 319, 112.5]);
  });

  test('10,000 setXray calls grow the heap by less than 256 KB (a toggle writes uniforms only, spec §5.3)', () => {
    const m = system('mesh');
    let k = 0;
    const call = (): void => {
      m.setXray((k & 1) === 0, -64 + (k & 31), 319 - (k & 15), 176 - (k & 7) * 0.5);
      k++;
    };
    for (let i = 0; i < 100_000; i++) call();
    v8.setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    const JIT_SPACE = /^(code|trusted|shared_trusted)_/;
    const heapUsed = (): number => {
      let b = 0;
      for (const s of v8.getHeapSpaceStatistics()) if (!JIT_SPACE.test(s.space_name)) b += s.space_used_size;
      return b;
    };
    const readings: number[] = [];
    for (let t = 0; t < 3; t++) {
      gc();
      gc();
      const before = heapUsed();
      const profiler = new v8.GCProfiler();
      profiler.start();
      for (let i = 0; i < 10_000; i++) call();
      const after = heapUsed();
      const gcs = profiler.stop()?.statistics.length ?? 0;
      if (gcs > 0) continue;
      readings.push(after - before);
      if (after - before < 256 * 1024) break;
    }
    expect(readings.length, 'every attempt saw a GC').toBeGreaterThan(0);
    expect(readings[readings.length - 1]!, `heap growth over 10,000 calls (attempts: ${readings.join(', ')})`).toBeLessThan(256 * 1024);
  });
});

describe('the water tiers (SP7a spec §7, D10, D28)', () => {
  const mainOf = (src: string): string => src.slice(src.indexOf('void main() {'));

  test('the water fragment declares waterTier and timeSeconds once and branches on waterTier: Fast keeps today\'s colour and the alpha uniform (0.72), Fancy the dFdx/dFdy normal, both ripple octaves, Schlick Fresnel (F0 0.02) toward skyColor(reflect(…)) and alpha 0.6 + 0.3·Fresnel', () => {
    for (const v of VARIANTS) {
      const src = SYSTEMS[v].water.fragmentShader;
      for (const decl of ['uniform float waterTier;', 'uniform float timeSeconds;']) {
        expect(src.split(decl).length - 1, `${v} ${decl}`).toBe(1);
      }
      const body = mainOf(src);
      // Fast: today's colour, the alpha uniform; Fancy overrides both inside the one uniform branch.
      expect(body).toContain('vec3 color = mix(waterShallow, waterDeep, vDepth / 15.0) * lightmapAt(vBlock, vSky);');
      expect(body).toContain('float a = alpha;');
      const branch = body.indexOf('if (waterTier > 0.5) {');
      expect(branch, `${v}: the waterTier branch`).toBeGreaterThan(body.indexOf('float a = alpha;'));
      expect(body.split('waterTier').length - 1, `${v}: one branch`).toBe(1);
      const fancy = body.slice(branch, body.indexOf('\n  }\n', branch));
      expect(fancy).toContain('vec3 n = normalize(cross(dFdx(vWorldPos), dFdy(vWorldPos)));');
      expect(fancy).toContain('n = normalize(n + rippleTilt(vWorldPos.xz, timeSeconds));');
      expect(fancy).toContain('float fresnel = 0.02 + 0.98 * pow(1.0 - clamp(dot(-viewDir, n), 0.0, 1.0), 5.0);');
      expect(fancy).toContain('skyColor(reflect(viewDir, n))');
      expect(fancy).toContain('a = 0.6 + 0.3 * fresnel;');
      expect(body).toContain('gl_FragColor = vec4(applyFog(color, vViewPos, vWorldPos), a);');
      // Both octaves: λ 4 and 1.7 blocks, scrolling 0.4 and 0.9 blocks/s along (1, 0) and (−0.6, 0.8), value-noise
      // gradients (no texture).
      expect(src).toContain('vec2 g = valueNoiseGrad((xz - vec2(1.0, 0.0) * (0.4 * t)) / 4.0)');
      expect(src).toContain('+ valueNoiseGrad((xz - vec2(-0.6, 0.8) * (0.9 * t)) / 1.7);');
      expect(src.split('valueNoiseGrad(').length - 1, `${v}: the definition and two octaves`).toBe(3);
      expect(src).not.toMatch(/sampler2D(?!\s+lightmap)/);
    }
  });

  test('one water material per variant (no second program): the tier is a uniform, not a define', () => {
    for (const v of VARIANTS) {
      const m = SYSTEMS[v];
      const materialKeys = Object.entries(m).filter(([, x]) => (x as { isShaderMaterial?: boolean })?.isShaderMaterial === true).map(([k]) => k);
      expect(materialKeys.filter((k) => /water/i.test(k)), v).toEqual(['water']);
      const tiered = Object.values(all(m)).filter((mat) => mat.fragmentShader.includes('waterTier'));
      expect(tiered, v).toEqual([m.water]);
      expect(Object.keys(m.water.defines).filter((d) => /TIER|FANCY|FAST/.test(d)), v).toEqual([]);
    }
  });

  test('defaults: waterTier 1 (Fancy, Medium\'s) and timeSeconds 0, one shared uniform object each in the water material', () => {
    for (const v of VARIANTS) {
      const fresh = system(v);
      expect(fresh.water.uniforms['waterTier']!.value, v).toBe(1);
      expect(fresh.water.uniforms['timeSeconds']!.value, v).toBe(0);
      for (const name of ['waterTier', 'timeSeconds']) {
        for (const mat of [fresh.terrainOpaque, fresh.terrainCutout, fresh.sky, fresh.ghost, fresh.xray]) {
          expect(mat.uniforms[name], `${v} ${mat.name} ${name}`).toBeUndefined();
        }
      }
    }
  });

  test('setFrameUniforms writes timeSeconds from FrameState.seconds', () => {
    const m = system('batch');
    m.setFrameUniforms({ ...FRAME, seconds: 12.5 });
    expect(m.water.uniforms['timeSeconds']!.value).toBe(12.5);
    m.setFrameUniforms({ ...FRAME, seconds: 3599.75 });
    expect(m.water.uniforms['timeSeconds']!.value).toBe(3599.75);
  });

  test('setWaterTier(0) then (1) writes the uniform and changes no material\'s version (no recompile)', () => {
    for (const v of VARIANTS) {
      const m = system(v);
      const versions = (): number[] => Object.values(all(m)).map((mat) => mat.version);
      const before = versions();
      const sources = Object.values(all(m)).map((mat) => mat.vertexShader + mat.fragmentShader);
      m.setWaterTier(0);
      expect(m.water.uniforms['waterTier']!.value, v).toBe(0);
      expect(versions(), v).toEqual(before);
      m.setWaterTier(1);
      expect(m.water.uniforms['waterTier']!.value, v).toBe(1);
      expect(versions(), v).toEqual(before);
      expect(Object.values(all(m)).map((mat) => mat.vertexShader + mat.fragmentShader), v).toEqual(sources);
    }
  });
});

describe('the underwater and lava fog (SP7a spec §8, D11)', () => {
  /** The occurrences of `needle` in `src`. */
  const count = (src: string, needle: string): number => src.split(needle).length - 1;
  /** The fragments that fog: terrain (opaque, cutout), the ghost (terrain's source with `GHOST`), water and the sky dome. */
  const fogged = (m: MaterialSystem): Record<string, ShaderMaterial> => ({
    terrainOpaque: m.terrainOpaque, terrainCutout: m.terrainCutout, ghost: m.ghost, water: m.water, sky: m.sky,
  });
  const FLUID_FOG_UNIFORMS = ['uniform float eyeFluid;', 'uniform vec3 fluidFogWater;', 'uniform vec3 fluidFogLava;'];

  test('the fog source holds both branches, water (L 56, the deep colour × the lightmap at the eye\'s sky light) and lava (L 3), f = 1 − 2^(−8·(d/L)²), and the 0.25 tint, from fogMath\'s constants', () => {
    const body = FLUID_FOG_GLSL.slice(FLUID_FOG_GLSL.indexOf('vec3 fluidFog(vec3 color, float d) {'));
    expect(body).toContain(`fogColor = fluidFogWater * lightmapAt(0.0, eyeSky);\n    x = d / ${glslFloat(FLUID_FOG_L_WATER)};`);
    expect(body).toContain(`fogColor = fluidFogLava;\n    x = d / ${glslFloat(FLUID_FOG_L_LAVA)};`);
    expect(body).toContain('if (eyeFluid > 1.5) {');
    expect(body).toContain(`float f = 1.0 - exp2(-${glslFloat(FLUID_FOG_SHARPNESS)} * x * x);`);
    expect(body).toContain(`return mix(mix(color, fogColor, ${glslFloat(FLUID_FOG_TINT)}), fogColor, f);`);
    // The literals the formula interpolates are fogMath's values.
    expect([glslFloat(FLUID_FOG_L_WATER), glslFloat(FLUID_FOG_L_LAVA), glslFloat(FLUID_FOG_SHARPNESS), glslFloat(FLUID_FOG_TINT)])
      .toEqual(['56.0', '3.0', '8.0', '0.25']);
    for (const decl of FLUID_FOG_UNIFORMS) expect(count(FLUID_FOG_GLSL, decl), decl).toBe(1);
    // The water fragment declares waterDeep itself (Fast's colour); the fog has its own uniform.
    expect(FLUID_FOG_GLSL).not.toContain('waterDeep');
    // FOG_GLSL includes it, and applyFog takes the fluid's fog in place of the sky's while the eye is in a fluid.
    expect(FOG_GLSL).toContain(FLUID_FOG_GLSL);
    const fog = FOG_GLSL.slice(FOG_GLSL.indexOf('vec3 applyFog('));
    const branch = fog.indexOf('if (eyeFluid > 0.5) return fluidFog(color, length(viewPos));');
    expect(branch).toBeGreaterThan(0);
    expect(branch).toBeLessThan(fog.indexOf('smoothstep(fogStart, fogEnd'));
  });

  test('each fogged fragment (terrain, cutout, ghost, water, sky) declares each fluid-fog uniform once and shares one object per name; no fragment declares waterDeep twice', () => {
    for (const v of VARIANTS) {
      const m = SYSTEMS[v];
      for (const [name, mat] of Object.entries(fogged(m))) {
        for (const decl of FLUID_FOG_UNIFORMS) expect(count(mat.fragmentShader, decl), `${v} ${name} ${decl}`).toBe(1);
        for (const u of ['eyeFluid', 'fluidFogWater', 'fluidFogLava', 'eyeSky', 'fogEnd', 'lightmap']) {
          expect(mat.uniforms[u], `${v} ${name} ${u}`).toBeDefined();
          expect(mat.uniforms[u], `${v} ${name} ${u}`).toBe(m.terrainOpaque.uniforms[u]);
        }
      }
      for (const [name, mat] of Object.entries(all(m))) {
        expect(count(mat.fragmentShader, 'uniform vec3 waterDeep;'), `${v} ${name}`).toBe(name === 'water' ? 1 : 0);
      }
    }
  });

  test('the X-ray material\'s sources hold no eyeFluid and no fluid fog, and its uniforms neither (it has no fog)', () => {
    for (const v of VARIANTS) {
      const x = SYSTEMS[v].xray;
      for (const s of [x.vertexShader, x.fragmentShader]) {
        expect(s, v).not.toContain('eyeFluid');
        expect(s, v).not.toContain('fluidFog');
      }
      for (const u of ['eyeFluid', 'fluidFogWater', 'fluidFogLava']) expect(x.uniforms[u], `${v} ${u}`).toBeUndefined();
      expect(SYSTEMS[v].decodeDebug.fragmentShader, v).not.toContain('eyeFluid');
    }
  });

  test('the sky dome applies the fluid fog at d = fogEnd while the eye is in a fluid, over its own uniforms and the fog\'s', () => {
    for (const v of VARIANTS) {
      const sky = SYSTEMS[v].sky;
      const src = sky.fragmentShader;
      expect(src).toContain('vec3 lightmapAt(float block, float sky)');
      for (const decl of ['uniform float fogEnd;', 'uniform float eyeSky;']) expect(count(src, decl), `${v} ${decl}`).toBe(1);
      expect(src).not.toContain('applyFog');
      const body = src.slice(src.indexOf('void main() {'));
      expect(body).toContain('vec3 c = skyColor(normalize(vDir));\n  if (eyeFluid > 0.5) c = fluidFog(c, fogEnd);\n  gl_FragColor = vec4(c, 1.0);');
      expect(Object.keys(sky.uniforms).sort(), v).toEqual(
        ['eyeFluid', 'eyeSky', 'fluidFogLava', 'fluidFogWater', 'fogEnd', 'lightmap', 'skyHorizon', 'skyZenith', 'sunDir'],
      );
    }
  });

  test('the fog colours: water\'s is Fast water\'s deep colour in linear, lava\'s [255, 90, 20] in linear × 0.6; eyeFluid 0 (none) by default', () => {
    const m = system('batch');
    const linear = (r: number, g: number, b: number): Color => new Color().setRGB(r / 255, g / 255, b / 255, SRGBColorSpace);
    expect((m.water.uniforms['fluidFogWater']!.value as Color).equals(m.water.uniforms['waterDeep']!.value as Color)).toBe(true);
    expect((m.water.uniforms['fluidFogWater']!.value as Color).equals(linear(16, 40, 96))).toBe(true);
    expect((m.water.uniforms['fluidFogLava']!.value as Color).equals(linear(255, 90, 20).multiplyScalar(0.6))).toBe(true);
    expect(m.water.uniforms['eyeFluid']!.value).toBe(0);
  });

  test('setFrameUniforms copies FrameState.eyeFluid into the eyeFluid uniform each frame, without allocation (Review Focus 3)', () => {
    const m = system('mesh');
    const u = m.terrainOpaque.uniforms['eyeFluid']!;
    const seen: number[] = [];
    for (const eyeFluid of [0, 1, 2, 1, 0, 2, 0]) {
      m.setFrameUniforms({ ...FRAME, eyeFluid });
      seen.push(u.value as number);
      expect(m.sky.uniforms['eyeFluid']).toBe(u);
      expect(m.water.uniforms['eyeFluid']).toBe(u);
    }
    expect(seen).toEqual([0, 1, 2, 1, 0, 2, 0]);
    // setFrameUniforms boxes the time and the day and dusk factors it hands on (about 35 B per call measured on Node 24;
    // `zeroAlloc.test.ts`' boxing budget of 256 B per tick covers them), so the copy is read against the same calls at a
    // constant eyeFluid: a surface crossed every 500 frames (20 crossings per 10,000; the frames reuse three states, as
    // the page reuses one) adds under 8 B per call, where one boxed number per call would add 16.
    const BOXING_MAX = 256 * N;
    const frames = [{ ...FRAME, eyeFluid: 0 }, { ...FRAME, eyeFluid: 1 }, { ...FRAME, eyeFluid: 2 }];
    const still = allocationOver(() => m.setFrameUniforms(frames[0]!), 10 * N, BOXING_MAX);
    expectAtRest(still, BOXING_MAX);
    let k = 0;
    const crossing = allocationOver(() => {
      const i = k++;
      m.setFrameUniforms(frames[((i / 500) | 0) % 3]!);
    }, 10 * N, BOXING_MAX);
    expectAtRest(crossing, BOXING_MAX);
    expect(crossing.bytes - still.bytes, `crossing ${crossing.bytes} B, still ${still.bytes} B over ${N} calls`).toBeLessThan(8 * N);
    expect(u.value).toBe(frames[(((k - 1) / 500) | 0) % 3]!.eyeFluid);
  });
});
