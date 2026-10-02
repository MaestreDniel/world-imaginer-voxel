/**
 * Parameter panel model (SP2b spec §3.2): the panel tree built from the schema, slider mappings, scope
 * badges, tooltips, the rules of the noise sub-block and the field rules of the controls (typed values,
 * issue lines, slider positions). Pure; the DOM lives in controls.ts and panel.ts.
 */
import type { RegenScope, StageId } from '../../core/ids';
import type { NoiseDef, NoiseDefPatch } from '../../core/noise/types';
import { q15 } from '../../core/params/canonical';
import { AMPLITUDE_MIN, NOISE_FIELD_RANGES, type Issue, type ParamKind, type ParamMeta } from '../../core/params/kit';
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

/** The leaf kinds the panel has a control for (spec §3.2's list); the panel throws for any other kind. */
export const PANEL_KINDS: readonly ParamKind[] = Object.freeze(['number', 'int', 'noise', 'spline', 'boxTable']);

/** Positions of a log slider, and the most any slider gets. */
export const SLIDER_POSITIONS = 1000;

/**
 * Positions of a control's range input: one per step of a linear stepped range (so a keyboard step is one
 * value step), at most SLIDER_POSITIONS; SLIDER_POSITIONS for a log or unstepped range.
 */
export function sliderPositions(c: ControlSpec): number {
  const [min, max] = sliderRange(c);
  if (c.scale !== 'linear' || c.step === undefined || !(c.step > 0)) return SLIDER_POSITIONS;
  const n = Math.round((max - min) / c.step);
  return n < 1 ? 1 : n > SLIDER_POSITIONS ? SLIDER_POSITIONS : n;
}

/**
 * The range input's position for the draft value `v`: `current` while it is a position that shows `v` (a
 * keyboard step that has not reached the next value keeps its place), else the nearest position to `v`.
 */
export function sliderPosition(c: ControlSpec, positions: number, current: number, v: number): number {
  if (Number.isInteger(current) && current >= 0 && current <= positions && sliderToValue(c, current / positions) === v) return current;
  return Math.round(valueToSlider(c, v) * positions);
}

/**
 * A typed field value: the number its trimmed text spells (`Number`, so '1e3' and '-.5' work), else the
 * trimmed text itself, so the validator's message names what was typed ('expected a number, got "abc"').
 */
export function parseFieldText(text: string): unknown {
  const t = text.trim();
  const n = t === '' ? Number.NaN : Number(t);
  return Number.isNaN(n) && t !== 'NaN' ? t : n;
}

/**
 * The issue lines a control shows: the message of an issue at `at`; any other issue prefixed by its path
 * relative to the leaf `base` (`amplitudes[2]: …`), or by its full path when it is not under the leaf.
 */
export function issueLines(issues: readonly Issue[], at: string, base: string): string[] {
  return issues.map((i) => {
    if (i.path === at) return i.message;
    const rel = i.path.startsWith(`${base}.`) ? i.path.slice(base.length + 1) : i.path.startsWith(`${base}[`) ? i.path.slice(base.length) : i.path;
    return `${rel}: ${i.message}`;
  });
}

/** A section header's count: '' when nothing under it is modified. */
export function modifiedText(n: number): string {
  return n === 0 ? '' : `${n} modified`;
}

/** The numeric fields of a noise sub-block besides the wavelength, in NOISE_KEYS order. */
export type NoiseNumberField = 'octaves' | 'persistence' | 'lacunarity' | 'yScale' | 'clampSigma';
export const NOISE_NUMBER_FIELDS: readonly NoiseNumberField[] = Object.freeze(['octaves', 'persistence', 'lacunarity', 'yScale', 'clampSigma']);

/** Tooltip text of each field of a noise sub-block. */
export const NOISE_FIELD_DOCS: Readonly<Record<keyof NoiseDef, string>> = Object.freeze({
  wavelength: 'Wavelength of the first octave, in blocks.',
  octaves: 'Number of octaves summed in each stack.',
  persistence: 'Amplitude ratio between successive octaves while amplitudes is the persistence weighting.',
  lacunarity: 'Frequency ratio between successive octaves.',
  amplitudes: 'Off: octave i weighs persistence^i. On: an explicit weight per octave (0 silences an octave).',
  yScale: 'Vertical frequency multiplier of a 3D noise.',
  clampSigma: 'The unit-variance sample is clamped to ± this many standard deviations.',
  double: 'Adds a second, independent stack at 337/331 of the frequency before normalising.',
  remap: "'uniform' maps the sample to a uniform value in [-1, 1] through its distribution (2D noises with double only).",
});

/**
 * A slider control for one numeric field of a noise leaf: the wavelength is the leaf's own log slider, the
 * other fields range over NOISE_FIELD_RANGES. Its path, `<leaf>.<field>`, is where the validator reports the
 * field's issues; the panel writes the field as a partial NoiseDef on the leaf.
 */
export function noiseFieldControl(c: ControlSpec, field: NoiseNumberField | 'wavelength'): ControlSpec {
  if (field === 'wavelength') return { ...c, path: `${c.path}.wavelength`, label: 'wavelength', doc: NOISE_FIELD_DOCS.wavelength };
  const R = NOISE_FIELD_RANGES[field];
  const kind: ParamKind = field === 'octaves' ? 'int' : 'number';
  return {
    path: `${c.path}.${field}`, kind, label: field, doc: NOISE_FIELD_DOCS[field],
    min: R.min, max: R.max, step: R.step, scale: scaleOf(kind, R.min, R.max), scope: c.scope,
    ...(c.stage !== undefined ? { stage: c.stage } : {}),
  };
}

/** Item `i` of an active amplitudes list replaced by a typed value (the session validates it); {} without a list or for an index outside it. */
export function amplitudeItemChange(def: NoiseDef, i: number, value: unknown): { readonly amplitudes?: readonly unknown[] } {
  const list = def.amplitudes;
  if (list === null || !Number.isInteger(i) || i < 0 || i >= list.length) return {};
  return { amplitudes: list.map((a, j) => (j === i ? value : a)) };
}
