import { createHash } from 'node:crypto';
import { Color, DoubleSide, GLSL3, NoColorSpace, SRGBColorSpace, type ShaderMaterial } from 'three';
import { describe, expect, test } from 'vitest';
import { skyColors, sunDirection } from '../../src/daynight/dayNight';
import { FOG_GLSL } from '../../src/render/materials/glsl/common.glsl';
import { packingGlsl } from '../../src/render/materials/glsl/packing.glsl';
import { GHOST_LIGHT_FLOOR, TERRAIN_FRAGMENT, terrainVertex } from '../../src/render/materials/glsl/terrain.glsl';
import { createMaterialSystem, fogRange, type MaterialSystem, type MaterialVariant } from '../../src/render/materials/index';
import { GHOST_ALPHA } from '../../src/render/materials/uniforms';
import { FACE_DOWN, FACE_EAST, FACE_NORTH, FACE_SOUTH, FACE_UP, FACE_WEST } from '../../src/world/blocks/kinds';
import type { FrameState } from '../../src/render/frameState';
import { createFlatColorArray } from '../../src/render/textureArray';

const ALBEDO = createFlatColorArray();
const system = (variant: MaterialVariant, ao = true, smoothLight = true): MaterialSystem =>
  createMaterialSystem({ variant, ao, smoothLight }, ALBEDO);
const SYSTEMS = { batch: system('batch'), mesh: system('mesh') } as const;
const VARIANTS = ['batch', 'mesh'] as const;

const all = (m: MaterialSystem): Record<string, ShaderMaterial> => ({
  terrainOpaque: m.terrainOpaque, terrainCutout: m.terrainCutout, water: m.water, sky: m.sky, decodeDebug: m.decodeDebug,
  ghost: m.ghost,
});
/** The terrain and water materials: the ones with a batched and a RegionMesh variant. */
const terrainAndWater = (m: MaterialSystem): ShaderMaterial[] => [m.terrainOpaque, m.terrainCutout, m.water];

const FRAME: FrameState = { t: 1 / 12, brightness: 0.3, eyeSky: 15, rd: 12, fogBand: 64 };

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

  test('dispose frees every material and the lightmap, not the albedo it was given', () => {
    const m = system('mesh');
    const disposed: string[] = [];
    for (const [name, mat] of Object.entries(all(m))) mat.addEventListener('dispose', () => disposed.push(name));
    m.lightmap.texture.addEventListener('dispose', () => disposed.push('lightmap'));
    ALBEDO.addEventListener('dispose', () => disposed.push('albedo'));
    m.dispose();
    expect(disposed.sort()).toEqual(['decodeDebug', 'ghost', 'lightmap', 'sky', 'terrainCutout', 'terrainOpaque', 'water']);
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
    expect(plain.length).toBe(SP5A_TERRAIN_FRAGMENT.length);
    expect(createHash('sha256').update(plain).digest('hex')).toBe(SP5A_TERRAIN_FRAGMENT.sha256);
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
