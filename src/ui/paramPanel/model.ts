/**
 * Parameter panel model (SP2b spec §3.2): the panel tree built from the schema, slider mappings, scope
 * badges, tooltips and the rules of the noise sub-block. Pure; the DOM lives in controls.ts and panel.ts.
 */
import type { RegenScope, StageId } from '../../core/ids';
import type { NoiseDef, NoiseDefPatch } from '../../core/noise/types';
import { q15 } from '../../core/params/canonical';
import { AMPLITUDE_MIN, NOISE_FIELD_RANGES, type ParamKind, type ParamMeta } from '../../core/params/kit';
import { SCHEMA } from '../../core/params/schema';

export interface ControlSpec {
  readonly path: string;
  readonly kind: ParamKind;
  readonly label: string;
  readonly doc: string;
  readonly unit?: string;
  /** The range of a number or int leaf, the wavelength range of a noise leaf, the y range of a spline leaf. */
  readonly min?: number;
  readonly max?: number;
  /** A UI hint for the slider; it never snaps a typed value. A noise leaf's wavelength step is 1 block. */
  readonly step?: number;
  readonly scale: 'linear' | 'log';
  readonly scope: RegenScope;
  readonly stage?: StageId;
  /** Noise leaves: whether the noise is 2D or 3D (it decides which noise fields a rule fixes). */
  readonly dims?: 2 | 3;
}

export interface SectionSpec {
  readonly path: string;
  readonly label: string;
  readonly doc: string;
  /** The group's leaves in schema order; the panel shows them before the sub-sections. */
  readonly controls: readonly ControlSpec[];
  readonly sections: readonly SectionSpec[];
}

/** A number slider is logarithmic when min > 0 and max / min reaches this ratio (spec §3.2). */
const LOG_RATIO = 20;
/** Wavelengths are in blocks; the noise lab uses the same step. */
const WAVELENGTH_STEP = 1;

function scaleOf(kind: ParamKind, min: number | undefined, max: number | undefined): 'linear' | 'log' {
  if (min === undefined || max === undefined || !(min > 0)) return 'linear';
  if (kind === 'noise') return 'log';
  return (kind === 'number' || kind === 'int') && max / min >= LOG_RATIO ? 'log' : 'linear';
}

function controlOf(meta: ParamMeta): ControlSpec {
  const step = meta.kind === 'noise' ? WAVELENGTH_STEP : meta.step;
  return {
    path: meta.path, kind: meta.kind, label: meta.label, doc: meta.doc,
    ...(meta.unit !== undefined ? { unit: meta.unit } : {}),
    ...(meta.min !== undefined ? { min: meta.min } : {}),
    ...(meta.max !== undefined ? { max: meta.max } : {}),
    ...(step !== undefined ? { step } : {}),
    scale: scaleOf(meta.kind, meta.min, meta.max),
    scope: meta.scope,
    ...(meta.stage !== undefined ? { stage: meta.stage } : {}),
    ...(meta.dims !== undefined ? { dims: meta.dims } : {}),
  };
}

interface SectionDraft {
  readonly path: string;
  readonly label: string;
  readonly doc: string;
  readonly controls: ControlSpec[];
  readonly sections: SectionDraft[];
}

const parentOf = (path: string): string => (path.includes('.') ? path.slice(0, path.lastIndexOf('.')) : '');

/** The panel tree from `SCHEMA.nodes` (pre-order): the root group is the root section. */
export function panelTree(): SectionSpec {
  const metas = new Map(SCHEMA.leaves.map((l) => [l.path, l.meta] as const));
  const sections = new Map<string, SectionDraft>();
  let root: SectionDraft | undefined;
  for (const { path, node } of SCHEMA.nodes) {
    if (node.tag === 'group') {
      const s: SectionDraft = { path, label: node.label, doc: node.doc, controls: [], sections: [] };
      sections.set(path, s);
      if (path === '') root = s;
      else sections.get(parentOf(path))!.sections.push(s);
    } else {
      sections.get(parentOf(path))!.controls.push(controlOf(metas.get(path)!));
    }
  }
  return root!;
}

function sliderRange(c: ControlSpec): readonly [number, number] {
  const sliding = c.kind === 'number' || c.kind === 'int' || c.kind === 'noise';
  if (!sliding || c.min === undefined || c.max === undefined) throw new Error(`no slider for ${c.path} (${c.kind})`);
  return [c.min, c.max];
}

/** Clamps to [0, 1]; NaN gives 0. */
const unit01 = (t: number): number => (t > 0 ? (t < 1 ? t : 1) : 0);

/** Slider position t ∈ [0, 1] → value: log or linear, snapped to the step grid from min, clamped, q15. */
export function sliderToValue(c: ControlSpec, t: number): number {
  const [min, max] = sliderRange(c);
  const u = unit01(t);
  let v = c.scale === 'log' ? min * (max / min) ** u : min + (max - min) * u;
  if (c.step !== undefined && c.step > 0) v = min + Math.round((v - min) / c.step) * c.step;
  if (c.kind === 'int') v = Math.round(v);
  return q15(Math.min(max, Math.max(min, v)));
}

/** Value → slider position in [0, 1] (clamped; a value the scale cannot place gives 0). */
export function valueToSlider(c: ControlSpec, v: number): number {
  const [min, max] = sliderRange(c);
  if (!(max > min)) return 0;
  return unit01(c.scale === 'log' ? Math.log(v / min) / Math.log(max / min) : (v - min) / (max - min));
}

const BADGES: Readonly<Record<RegenScope, { readonly label: string; readonly tip: string }>> = {
  live: { label: 'Live', tip: 'applies at once, recomputes nothing' },
  remesh: { label: 'Remesh', tip: 'rebuilds meshes, keeps every voxel' },
  decorate: { label: 'Decorate', tip: 'recomputes decorations, keeps the terrain' },
  terrain: { label: 'Terrain', tip: 'recomputes shape and biomes, keeps raw climate' },
  climate: { label: 'Climate', tip: 'recomputes everything' },
};

export function scopeBadge(scope: RegenScope): { readonly label: string; readonly tip: string } {
  return BADGES[scope];
}

/** The control's tooltip: doc, range with unit (a noise leaf's wavelength range), path. */
export function controlTip(c: ControlSpec): string {
  const lines = [c.doc];
  if (c.min !== undefined && c.max !== undefined) {
    const unit = c.kind === 'noise' ? 'blocks' : c.unit;
    lines.push(`${c.kind === 'noise' ? 'Wavelength' : 'Range'}: ${c.min} … ${c.max}${unit !== undefined ? ` ${unit}` : ''}`);
  } else if (c.unit !== undefined) {
    lines.push(`Unit: ${c.unit}`);
  }
  lines.push(`Path: ${c.path}`);
  return lines.join('\n');
}

/**
 * The amplitudes toggle (spec §3.2): to a list writes q15(persistence^i) for i < octaves, with any item
 * below 1e-6 written as 0; back writes null. A toggle to the current state is an empty patch.
 */
export function amplitudesToggle(def: NoiseDef, toList: boolean): NoiseDefPatch {
  if (toList === (def.amplitudes !== null)) return {};
  if (!toList) return { amplitudes: null };
  const amplitudes: number[] = [];
  for (let i = 0; i < def.octaves; i++) {
    const a = q15(def.persistence ** i);
    amplitudes.push(Math.abs(a) < AMPLITUDE_MIN ? 0 : a);
  }
  return { amplitudes };
}

/**
 * An octaves edit (spec §3.2): while a list is active it is resized in the same patch (truncated, or
 * extended with 0). An octaves value the validator refuses is written alone, so its issue is the only one.
 */
export function octavesChange(def: NoiseDef, octaves: number): NoiseDefPatch {
  const R = NOISE_FIELD_RANGES.octaves;
  if (def.amplitudes === null || !Number.isInteger(octaves) || octaves < R.min || octaves > R.max) return { octaves };
  const amplitudes = def.amplitudes.slice(0, octaves);
  while (amplitudes.length < octaves) amplitudes.push(0);
  return { octaves, amplitudes };
}

/** Why a validation rule fixes this noise field for the current definition, or null when it is editable. */
export function noiseFieldLock(c: ControlSpec, def: NoiseDef, field: keyof NoiseDef): string | null {
  switch (field) {
    case 'yScale': return c.dims === 2 ? 'a 2D noise has yScale 1' : null;
    case 'remap':
      if (c.dims === 3) return "remap 'uniform' is for 2D noises";
      return def.double ? null : "remap 'uniform' needs double: true";
    case 'double': return def.remap === 'uniform' ? "remap 'uniform' needs double: true" : null;
    default: return null;
  }
}
