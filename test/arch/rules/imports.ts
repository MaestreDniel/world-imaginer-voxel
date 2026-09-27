import { layerOf, resolveTarget, type Edge, type ScannedFile, type Violation } from '../scan';

interface LayerRule {
  value: readonly string[];
  typeOnly?: readonly string[];
  deny?: readonly string[];
}

const LAYERS = ['core', 'world', 'gen', 'textures', 'audio', 'light', 'mesh', 'sim', 'persist', 'metrics',
  'daynight', 'workers', 'engine', 'render', 'player', 'sound', 'ui', 'main'] as const;
const L2_CORE = ['core', 'world', 'gen', 'textures', 'audio', 'light', 'mesh', 'sim', 'persist'];
const LIGHT_MESH = ['core', 'world/blocks/**', 'world/store/padded.ts', 'gen', 'textures', 'audio', 'light', 'mesh'];

/** SP0 spec "Dependency table" (refines master §1). */
export const LAYER_RULES: Readonly<Record<string, LayerRule>> = {
  core: { value: ['core'] },
  world: { value: ['core', 'world'] },
  gen: { value: ['core', 'gen', 'world/blocks/**'], typeOnly: ['world/store/api.ts'] },
  textures: { value: ['core', 'textures'] },
  audio: { value: ['core', 'audio', 'world/blocks/**'], typeOnly: ['world/store/api.ts'] },
  light: { value: LIGHT_MESH, typeOnly: ['world/store/api.ts'] },
  mesh: { value: LIGHT_MESH, typeOnly: ['world/store/api.ts'] },
  sim: { value: L2_CORE },
  persist: { value: L2_CORE },
  metrics: { value: [...L2_CORE, 'metrics'] },
  daynight: { value: ['core', 'daynight'] },
  workers: { value: [...L2_CORE, 'metrics', 'daynight', 'workers'] },
  engine: { value: ['core', 'world', 'engine', 'workers/protocol.ts'], typeOnly: ['gen', 'textures', 'audio', 'light', 'mesh', 'sim', 'persist', 'metrics'] },
  render: { value: ['core', 'world', 'light', 'mesh', 'textures', 'daynight', 'render', 'workers/protocol.ts'] },
  player: { value: ['core', 'world', 'daynight', 'player', 'workers/protocol.ts'], typeOnly: ['engine', 'render'], deny: ['render/materials/**'] },
  sound: { value: ['core', 'world', 'audio', 'daynight', 'sound', 'workers/protocol.ts'], typeOnly: ['engine'] },
  ui: { value: LAYERS, deny: ['render/materials/**', '*.worker.ts'] },
  main: { value: LAYERS, deny: ['*.worker.ts'] },
};

/** `srcRel` is a path under src/, e.g. `world/store/api.ts`. */
function matches(srcRel: string, pattern: string): boolean {
  if (pattern === '*.worker.ts') return srcRel.endsWith('.worker.ts');
  if (pattern.endsWith('/**')) return srcRel.startsWith(pattern.slice(0, -2));
  if (pattern.includes('/')) return srcRel === pattern;
  return layerOf(`src/${srcRel}`) === pattern;
}

function allowed(rule: LayerRule, srcRel: string, kind: Edge['kind']): boolean {
  if (rule.deny?.some((p) => matches(srcRel, p))) return false;
  if (rule.value.some((p) => matches(srcRel, p))) return true;
  return kind === 'type' && (rule.typeOnly ?? []).some((p) => matches(srcRel, p));
}

const TEST_IMPORT_EXCEPTIONS: ReadonlyArray<{ from: (f: ScannedFile) => boolean; target: string }> = [
  { from: (f) => f.layer === 'main' || f.layer === 'ui', target: 'test/goldens.json' },
  { from: (f) => f.path === 'src/ui/metricsDashboard.ts', target: 'test/thresholds.ts' },
];

function checkEdge(f: ScannedFile, layer: string, e: Edge): Violation | null {
  const at = (rule: string, message: string): Violation => ({ file: f.path, line: e.line, rule, message });
  if (e.kind === 'type-import-expr') return at('type-import-expr', `use import type instead of import('${e.spec}')`);
  if (e.kind === 'dynamic-nonliteral') return at('dynamic-nonliteral', 'dynamic import with a non-literal specifier');
  const t = resolveTarget(f.path, e.spec, e.kind);
  if (t.kind === 'bare') {
    const isThree = t.name === 'three' || t.name.startsWith('three/');
    return isThree && layer !== 'render' ? at('three-outside-render', `${layer} imports ${t.name}`) : null;
  }
  if (t.kind !== 'repo') return null;
  const target = t.path;
  if (e.kind === 'worker') {
    return layer === 'engine' && target.endsWith('.worker.ts') ? null : at('worker-edge', `only engine/ may spawn workers (${target})`);
  }
  if (target.endsWith('.worker.ts')) return at('worker-import', `worker entry ${target} must not be imported`);
  if (target.startsWith('test/')) {
    const ok = TEST_IMPORT_EXCEPTIONS.some((x) => x.target === target && x.from(f));
    return ok ? null : at('test-import', `src must not import ${target}`);
  }
  if (!target.startsWith('src/')) return null;
  const srcRel = target.slice('src/'.length);
  if (srcRel.startsWith('render/materials/') && layer !== 'render') {
    return at('materials-outside-render', `${layer} imports ${srcRel}`);
  }
  const rule = LAYER_RULES[layer]!;
  return allowed(rule, srcRel, e.kind) ? null : at('layer', `${layer} may not import ${srcRel}${e.kind === 'type' ? ' (type-only)' : ''}`);
}

export function checkImports(files: readonly ScannedFile[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (!f.path.startsWith('src/')) continue;
    const layer = f.layer;
    if (layer === null || !(layer in LAYER_RULES)) {
      out.push({ file: f.path, line: 1, rule: 'unknown-layer', message: `no layer for ${f.path}; amend the dependency table` });
      continue;
    }
    for (const e of f.edges) {
      const v = checkEdge(f, layer, e);
      if (v) out.push(v);
    }
  }
  return out;
}
