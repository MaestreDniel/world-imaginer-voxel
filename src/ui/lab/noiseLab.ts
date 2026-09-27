import './lab.css';
import { NormalNoise } from '../../core/noise/normal';
import { toUniform } from '../../core/noise/cdf';
import type { NoiseDef } from '../../core/noise/types';
import { NOISE_FIELD_RANGES, SCHEMA, type Params, type ParamsPatch } from '../../core/params/schema';
import { applyPatch, patchAt } from '../../core/params/kit';
import { noiseInstances } from '../../core/params/noises';
import { seedFromInput } from '../../core/seed';
import { pearson } from '../../metrics/noiseStats';
import { ADVERSARIAL_DEFS, DENSITY3D_DEF } from '../../metrics/sp1Fixtures';
import { resolveSeedText } from '../seedBox';
import { mountDeterminismPanel } from './determinismPanel';
import { createFieldView, type Camera, type FieldView } from './fieldView';
import { decodeLabState, DEFAULT_LAB_STATE, encodeLabState, labParams, mergePatch, type LabState } from './labState';
import { createStatsPanel, type StatsPanel } from './statsPanel';

/** One selectable noise: a schema instance (editable through its leaf path) or a test fixture (read-only). */
export interface LabNoise {
  readonly seedName: string;
  readonly path: string | null;
  readonly def: NoiseDef;
  readonly dims: 2 | 3;
}

export function labNoises(params: Params): LabNoise[] {
  return [
    ...noiseInstances(SCHEMA, params).map((i) => ({ seedName: i.seedName, path: i.path, def: i.def, dims: i.dims })),
    ...[DENSITY3D_DEF, ...ADVERSARIAL_DEFS].map((f) => ({ seedName: f.seedName, path: null, def: f.def, dims: f.dims })),
  ];
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className !== '') e.className = className;
  if (text !== '') e.textContent = text;
  return e;
}

export interface Side {
  readonly seed: string;
  readonly noise: LabNoise;
  /** Value at world (a, b) of the view plane. */
  sample(a: number, b: number): number;
  readonly lo: number;
  readonly hi: number;
  readonly nn: NormalNoise;
}

/** Builds the sampling function of one side for the current view (SP1 spec §6). */
export function makeSide(seedText: string, noise: LabNoise, state: LabState): Side {
  const nn = new NormalNoise(seedFromInput(seedText), noise.seedName, noise.def);
  const u = state.view.mode === 'u' && noise.def.remap === 'uniform';
  const slice = state.view.slice ?? 64;
  const plane = state.view.plane ?? 'xz';
  const raw = noise.dims === 2 ? (a: number, b: number) => nn.z2(a, b)
    : plane === 'xz' ? (a: number, b: number) => nn.z3(a, slice, b) : (a: number, b: number) => nn.z3(a, b, slice);
  const sample = u ? (a: number, b: number) => toUniform(raw(a, b)) : raw;
  return { seed: seedText, noise, sample, lo: u ? -1 : -nn.clamp, hi: u ? 1 : nn.clamp, nn };
}

export interface LabContext {
  state: LabState;
  readonly setState: (next: LabState) => void;
}

/** Mounts the ?lab=noise page into `root` (Task 24 adds statistics and A/B). */
export function mountNoiseLab(root: HTMLElement): void {
  const decoded = decodeLabState(location.hash);
  let state = decoded.state;
  const lab = el('div', 'lab');
  const header = el('div', 'lab-header');
  header.append(el('strong', '', 'world-imaginer-voxel · noise lab'));
  const notice = el('span', 'lab-notice', decoded.error ?? '');
  header.append(notice);
  const toolbar = el('div', 'lab-toolbar');
  const views = el('div', 'lab-views');
  const side = el('div', 'lab-side');
  lab.append(header, toolbar, views, side);
  root.replaceChildren(lab);

  const noiseSelect = el('select');
  const seedInput = el('input');
  seedInput.placeholder = 'seed (empty = random)';
  const modeSelect = el('select');
  for (const m of ['u', 'z']) modeSelect.append(new Option(m === 'u' ? 'u (uniform)' : 'z (normal)', m));
  const planeSelect = el('select');
  for (const p of ['xz', 'xy']) planeSelect.append(new Option(`plane ${p}`, p));
  const sliceInput = el('input');
  sliceInput.type = 'number';
  sliceInput.step = '1';
  toolbar.append(noiseSelect, seedInput, modeSelect, planeSelect, sliceInput);

  const readout = el('div', 'lab-readout');
  const formTitle = el('h3', '', 'NoiseDef');
  const form = el('div', 'lab-form');
  const issues = el('div', 'lab-issues');
  side.append(readout, formTitle, form, issues);
  const abButton = el('button', '', 'A/B');
  const bSeedInput = el('input');
  bSeedInput.placeholder = 'B seed (empty = same as A)';
  const copyButton = el('button', '', 'copy A → B');
  toolbar.append(abButton, bSeedInput, copyButton);
  const targetSelect = el('select');
  targetSelect.append(new Option('edit A', 'A'), new Option('edit B', 'B'));
  toolbar.append(targetSelect);
  let target: 'A' | 'B' = 'A';
  targetSelect.addEventListener('change', () => { target = targetSelect.value === 'B' ? 'B' : 'A'; render(); });
  const statsA: StatsPanel = createStatsPanel(side, 'Statistics A');
  let statsB: StatsPanel | null = null;
  const corr = el('div', 'lab-readout');
  side.append(corr);
  let zA: Float64Array | null = null;
  let zB: Float64Array | null = null;
  const showCorr = () => { corr.textContent = zA !== null && zB !== null ? `r(A, B) = ${pearson(zA, zB).toFixed(4)}` : ''; };
  statsA.onDone = (z) => { zA = z; showCorr(); };
  let viewB: FieldView | null = null;
  let viewBHost: HTMLElement | null = null;

  const viewHost = el('div', 'lab-view');
  views.append(viewHost);
  const onCamera = (cam: Camera) => setState({ ...state, view: { ...state.view, x: cam.x, z: cam.z, bpp: cam.bpp } });
  const view: FieldView = createFieldView(viewHost, {
    onCamera,
    onHover: (a, b, v) => { readout.textContent = `x ${a.toFixed(1)}  ${state.view.plane === 'xy' ? 'y' : 'z'} ${b.toFixed(1)}  value ${v.toFixed(4)}`; },
  });

  const current = (): { params: Params; noises: LabNoise[]; noise: LabNoise } => {
    const { a } = labParams(state);
    const noises = labNoises(a);
    const noise = noises.find((n) => n.seedName === state.noise) ?? noises.find((n) => n.seedName === DEFAULT_LAB_STATE.noise)!;
    return { params: a, noises, noise };
  };

  function setState(next: LabState): void {
    state = next;
    history.replaceState(null, '', `?lab=noise#${encodeLabState(state)}`);
    render();
  }

  const editPatch = (path: string, field: keyof NoiseDef, value: unknown) => {
    const delta = patchAt(path, { [field]: value });
    const show = (r: ReturnType<typeof applyPatch>) => { issues.textContent = r.ok ? '' : r.issues.map((i) => `${i.path}: ${i.code} — ${i.message}`).join('\n'); return r.ok; };
    if (target === 'B' && state.b !== undefined) {
      const nextB = mergePatch(state.b.patch ?? {}, delta) as ParamsPatch;
      if (show(applyPatch(SCHEMA, labParams(state).a, nextB))) setState({ ...state, b: { ...state.b, patch: nextB } });
      return;
    }
    const next = mergePatch(state.patch, delta) as ParamsPatch;
    if (show(applyPatch(SCHEMA, SCHEMA.defaults, next))) setState({ ...state, patch: next });
  };

  function renderForm(noise: LabNoise): void {
    form.replaceChildren();
    const R = NOISE_FIELD_RANGES;
    const editable = noise.path !== null;
    const numberField = (field: keyof NoiseDef, min: number, max: number, step: number, disabled = false) => {
      const input = el('input');
      input.type = 'number';
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.value = String(noise.def[field]);
      input.disabled = !editable || disabled;
      input.addEventListener('change', () => editPatch(noise.path!, field, Number(input.value)));
      const label = el('label', '', field);
      label.append(input);
      form.append(label);
    };
    numberField('wavelength', 1, 1e6, 1);
    numberField('octaves', R.octaves.min, R.octaves.max, R.octaves.step);
    numberField('persistence', R.persistence.min, R.persistence.max, R.persistence.step);
    numberField('lacunarity', R.lacunarity.min, R.lacunarity.max, R.lacunarity.step);
    numberField('yScale', R.yScale.min, R.yScale.max, R.yScale.step, noise.dims === 2);
    numberField('clampSigma', R.clampSigma.min, R.clampSigma.max, R.clampSigma.step);
    const amps = el('input');
    amps.value = noise.def.amplitudes === null ? '' : noise.def.amplitudes.join(', ');
    amps.placeholder = 'empty = persistence';
    amps.disabled = !editable;
    amps.addEventListener('change', () => {
      const t = amps.value.trim();
      editPatch(noise.path!, 'amplitudes', t === '' ? null : t.split(',').map((s) => Number(s.trim())));
    });
    const ampsLabel = el('label', '', 'amplitudes');
    ampsLabel.append(amps);
    const dbl = el('input');
    dbl.type = 'checkbox';
    dbl.checked = noise.def.double;
    dbl.disabled = !editable;
    dbl.addEventListener('change', () => editPatch(noise.path!, 'double', dbl.checked));
    const dblLabel = el('label', '', 'double');
    dblLabel.append(dbl);
    const remap = el('select');
    for (const r of ['none', 'uniform']) remap.append(new Option(r, r));
    remap.value = noise.def.remap;
    remap.disabled = !editable;
    remap.addEventListener('change', () => editPatch(noise.path!, 'remap', remap.value));
    const remapLabel = el('label', '', 'remap');
    remapLabel.append(remap);
    form.append(ampsLabel, dblLabel, remapLabel);
    if (!editable) form.append(el('div', 'lab-notice', 'test fixture (read-only)'));
  }

  function render(): void {
    const { noises, noise } = current();
    noiseSelect.replaceChildren();
    const groups = { schema: el('optgroup'), test: el('optgroup') };
    groups.schema.label = 'schema';
    groups.test.label = 'test fixtures';
    for (const n of noises) (n.path === null ? groups.test : groups.schema).append(new Option(n.seedName, n.seedName));
    noiseSelect.append(groups.schema, groups.test);
    noiseSelect.value = noise.seedName;
    seedInput.value = state.seed;
    modeSelect.value = state.view.mode;
    planeSelect.hidden = noise.dims === 2;
    sliceInput.hidden = noise.dims === 2;
    planeSelect.value = state.view.plane ?? 'xz';
    sliceInput.value = String(state.view.slice ?? 64);
    const editB = target === 'B' && state.b !== undefined;
    const formNoise = editB ? labNoises(labParams(state).b!).find((n) => n.seedName === noise.seedName) ?? noise : noise;
    formTitle.textContent = `NoiseDef (${editB ? 'B' : 'A'})`;
    renderForm(formNoise);
    const a = makeSide(state.seed, noise, state);
    const cam = { x: state.view.x, z: state.view.z, bpp: state.view.bpp };
    view.setSource(a.sample, a.lo, a.hi);
    view.setCamera(cam);
    zA = null;
    zB = null;
    showCorr();
    statsA.update(a);
    abButton.textContent = state.b === undefined ? 'A/B: off' : 'A/B: on';
    bSeedInput.hidden = state.b === undefined;
    copyButton.hidden = state.b === undefined;
    targetSelect.hidden = state.b === undefined;
    if (state.b === undefined) {
      viewB?.destroy();
      viewBHost?.remove();
      statsB?.destroy();
      viewB = null;
      viewBHost = null;
      statsB = null;
      return;
    }
    const { b } = labParams(state);
    const noiseB = labNoises(b!).find((n) => n.seedName === noise.seedName) ?? noise;
    const sideB = makeSide(state.b.seed ?? state.seed, noiseB, state);
    if (viewB === null) {
      viewBHost = el('div', 'lab-view');
      views.append(viewBHost);
      viewB = createFieldView(viewBHost, { onCamera, onHover: () => {} });
      statsB = createStatsPanel(side, 'Statistics B');
      statsB.onDone = (z) => { zB = z; showCorr(); };
    }
    bSeedInput.value = state.b.seed ?? '';
    viewB.setSource(sideB.sample, sideB.lo, sideB.hi);
    viewB.setCamera(cam);
    statsB!.update(sideB);
  }

  noiseSelect.addEventListener('change', () => setState({ ...state, noise: noiseSelect.value }));
  seedInput.addEventListener('change', () => {
    const r = resolveSeedText(seedInput.value);
    seedInput.value = r.text;
    setState({ ...state, seed: r.text });
  });
  modeSelect.addEventListener('change', () => setState({ ...state, view: { ...state.view, mode: modeSelect.value === 'z' ? 'z' : 'u' } }));
  planeSelect.addEventListener('change', () => setState({ ...state, view: { ...state.view, plane: planeSelect.value === 'xy' ? 'xy' : 'xz' } }));
  sliceInput.addEventListener('change', () => setState({ ...state, view: { ...state.view, slice: Number(sliceInput.value) } }));

  abButton.addEventListener('click', () => {
    if (state.b === undefined) setState({ ...state, b: {} });
    else { const { b: _off, ...rest } = state; setState(rest); }
  });
  bSeedInput.addEventListener('change', () => {
    const t = bSeedInput.value.trim();
    const { seed: _old, ...restB } = state.b ?? {};
    setState({ ...state, b: t === '' ? restB : { ...restB, seed: t } });
  });
  copyButton.addEventListener('click', () => setState({ ...state, b: {} }));

  if (!current().noises.some((n) => n.seedName === state.noise)) notice.textContent = `unknown noise ${state.noise}; showing ${DEFAULT_LAB_STATE.noise}`;
  mountDeterminismPanel(side);
  render();
}
