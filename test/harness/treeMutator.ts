/**
 * The untrusted-JSON mutator (SP3d spec §10 "Fuzz of untrusted JSON", §7 DT2's edited parts): random edits of a
 * `density.defs` or `surface.rules` value, drawn from a u32 stream (`testRng`, or a Xoshiro128's `nextU32`), so a seed
 * reproduces every value.
 *
 * - Bases (`mutationBase`): the default tree of the format (`DEFAULT_DENSITY_TREE`, `DEFAULT_SURFACE_RULES`) or a
 *   valid-by-construction fuzz tree drawn over the schema's noises (`randomDensityExpr` with `SCHEMA_DENSITY_NOISES` and
 *   `negativeZero: false`; `randomSurfaceRules` with `SCHEMA_SURFACE_NOISES`, any style), so tier 2 does not refuse a
 *   base for its noise ids alone.
 * - Breaking mutations (`BREAKING_MUTATIONS`): delete or add keys, swap ops and kinds, numbers set to −0, NaN, ±∞,
 *   ±1e308, ±(1e9 + 1) and huge or tiny exponents, very deep and very wide nesting, arrays, strings and other
 *   primitives in node slots, def, tap, biome, block, noise and field names empty, dotted, `__proto__` (an own key, as
 *   `JSON.parse` makes it), `constructor`, `toString` and over-long, param paths of the same names and to missing or
 *   non-numeric targets, refs to missing defs, ref cycles, knots with overflowing slopes, long knot lists (64 knots,
 *   the most tier 2 accepts, or 65, 200 and 1,024), air and unknown blocks,
 *   oversized values (too many values, too long arrays and strings, too large a text).
 * - Structure-preserving mutations (`PRESERVING_MUTATIONS`): change a literal within its range, swap two siblings,
 *   replace a literal by a param ref (int fields take only int targets), wrap a node in a tap (rules: a rule in a
 *   one-child sequence, a condition in a double `not`), mute a tap, add a def and reference it (rules: duplicate a
 *   branch).
 *
 * A mutation never changes its input (the bases are frozen): it works on a copy (`cloneTree`, which keeps −0 and own
 * `__proto__` keys). Breaking mutations are not guaranteed to be refused, nor preserving ones accepted: the fuzz only
 * requires that every value is either refused with paths or accepted and then sound. Lookups keyed by tree content use
 * own properties only (names such as `constructor` are valid).
 */
import { DEFAULT_DENSITY_TREE, DEFAULT_SURFACE_RULES } from '../../src/core/params/defaultTrees';
import type { JsonFormat } from '../../src/core/params/json';
import { ALLOWED_REF_TARGETS, SOURCE_CHILD_KEYS, SOURCE_OPS, type SourceOp } from '../../src/gen/density/source';
import { CONDITION_KINDS, RULE_KINDS } from '../../src/gen/surface/rules';
import { randomDensityExpr, SCHEMA_DENSITY_NOISES } from './densityFuzz';
import { testFloat } from './stats';
import { randomSurfaceRules, SCHEMA_SURFACE_NOISES, type SurfaceFuzzStyle } from './surfaceFuzz';

type Obj = Record<string, unknown>;
type Container = Obj | unknown[];

export type MutationClass = 'breaking' | 'preserving';

export const BREAKING_MUTATIONS = [
  'deleteKey', 'addKey', 'swapOp', 'badNumber', 'deepNesting', 'wideNesting', 'wrongType', 'badName', 'refCycle',
  'missingTarget', 'knotsOverflow', 'knotsGrow', 'airBlock', 'oversized',
] as const;
export const PRESERVING_MUTATIONS = ['changeLiteral', 'swapSiblings', 'literalToParam', 'wrap', 'muteTap', 'addDef'] as const;
export type MutationName = (typeof BREAKING_MUTATIONS)[number] | (typeof PRESERVING_MUTATIONS)[number];

/** The mutations that exist for a format (the others have no counterpart there). */
const DENSITY_ONLY: ReadonlySet<MutationName> = new Set(['refCycle', 'knotsOverflow', 'knotsGrow', 'muteTap']);
const RULES_ONLY: ReadonlySet<MutationName> = new Set(['airBlock']);
export function mutationsOf(format: JsonFormat, cls: MutationClass): readonly MutationName[] {
  const all: readonly MutationName[] = cls === 'breaking' ? BREAKING_MUTATIONS : PRESERVING_MUTATIONS;
  return all.filter((m) => (format === 'density' ? !RULES_ONLY.has(m) : !DENSITY_ONLY.has(m)));
}

export interface TreeMutation {
  /** The mutated value (a fresh tree; the base is never changed). */
  readonly value: unknown;
  /** The mutations applied, in order. */
  readonly names: readonly MutationName[];
  readonly cls: MutationClass;
}

export interface MutateOptions {
  /** Only this class (default: breaking or preserving, one draw). */
  readonly cls?: MutationClass;
  /** Mutations applied one after the other (default 1). */
  readonly count?: number;
}

/**
 * A deep copy of a JSON-like value (plain objects and arrays; primitives as they are, −0 included): every own enumerable
 * key is defined with `Object.defineProperty`, so a `__proto__` key stays an own key. Recursive: for bases and the
 * values this module builds, not for adversarial input.
 */
export function cloneTree(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(cloneTree);
  if (typeof v !== 'object' || v === null) return v;
  const out: Obj = {};
  for (const k of Object.keys(v)) define(out, k, cloneTree((v as Obj)[k]));
  return out;
}

function define(o: Obj, k: string, v: unknown): void {
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
}

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const own = (o: Obj, k: string): unknown => (Object.hasOwn(o, k) ? o[k] : undefined);

/**
 * A base value for the fuzz: half the time the format's default tree, else a fuzz tree over the schema's noises (density:
 * at most 3 defs, height ≤ 6; rules: the three styles in turn by draw). The default is returned as itself (frozen).
 */
export function mutationBase(next: () => number, format: JsonFormat): unknown {
  if (next() % 2 === 0) return format === 'density' ? DEFAULT_DENSITY_TREE : DEFAULT_SURFACE_RULES;
  if (format === 'density') return randomDensityExpr(next, { noises: SCHEMA_DENSITY_NOISES, negativeZero: false });
  const styles: readonly SurfaceFuzzStyle[] = ['free', 'fastPath', 'nearMiss'];
  return randomSurfaceRules(next, { style: styles[next() % 3]!, noises: SCHEMA_SURFACE_NOISES });
}

/** A slot holding a node: `parent[key]` is a node object (density op node; rules rule or condition). */
interface Slot {
  readonly parent: Container;
  readonly key: string | number;
  /** density: 'node'; rules: 'rule' or 'cond'. */
  readonly role: 'node' | 'rule' | 'cond';
  /** Inside an `interpolated` (density), for information only. */
  readonly depth: number;
}

/** A numeric field: `parent[key]` is a number (or, with `ref`, a ref object `{param, neg?}`). */
interface Field {
  readonly parent: Container;
  readonly key: string | number;
  /** An int field of the rules (offset, minY, the gradient bounds). */
  readonly int: boolean;
  /** density: a field that takes the ref form (not `const.v`, which takes a `param` node). */
  readonly refable: boolean;
}

const RULE_INT_FIELDS: ReadonlySet<string> = new Set(['offset', 'minY', 'trueAtAndBelow', 'falseAtAndAbove']);
const RULE_NUMBER_FIELDS: ReadonlySet<string> = new Set(['offset', 'minY', 'trueAtAndBelow', 'falseAtAndAbove', 'min', 'max', 't']);
const DENSITY_REF_FIELDS: ReadonlySet<string> = new Set(['lo', 'hi', 'mute']);
const SOURCE_OP_SET: ReadonlySet<string> = new Set<string>(SOURCE_OPS);

/** Child keys of a density node (unknown op: none). */
function densityKids(n: Obj): readonly string[] {
  const op = own(n, 'op');
  return typeof op === 'string' && SOURCE_OP_SET.has(op) ? SOURCE_CHILD_KEYS[op as SourceOp] : [];
}

/** The mutable model of one value: a holder whose `v` is the tree, its node slots and numeric fields. */
class Tree {
  readonly holder: Obj;
  readonly format: JsonFormat;
  constructor(value: unknown, format: JsonFormat) {
    this.format = format;
    this.holder = {};
    define(this.holder, 'v', cloneTree(value));
  }

  get value(): unknown { return this.holder['v']; }

  /** Every node slot, in pre-order (iterative). */
  slots(): Slot[] {
    const out: Slot[] = [];
    const stack: Slot[] = [];
    const v = this.value;
    if (this.format === 'density') {
      if (!isObj(v)) return out;
      const defs = own(v, 'defs');
      if (isObj(defs)) for (const k of Object.keys(defs).reverse()) stack.push({ parent: defs, key: k, role: 'node', depth: 1 });
      stack.push({ parent: v, key: 'root', role: 'node', depth: 1 });
    } else {
      stack.push({ parent: this.holder, key: 'v', role: 'rule', depth: 1 });
    }
    while (stack.length > 0) {
      const s = stack.pop()!;
      const n = (s.parent as Obj)[s.key as string];
      if (!isObj(n)) continue;
      out.push(s);
      if (s.depth > 400) continue;
      const kids: Slot[] = [];
      if (this.format === 'density') {
        for (const k of densityKids(n)) kids.push({ parent: n, key: k, role: 'node', depth: s.depth + 1 });
      } else if (s.role === 'rule') {
        const rules = own(n, 'rules');
        if (Array.isArray(rules)) for (let i = 0; i < rules.length; i++) kids.push({ parent: rules, key: i, role: 'rule', depth: s.depth + 1 });
        if (Object.hasOwn(n, 'if')) kids.push({ parent: n, key: 'if', role: 'cond', depth: s.depth + 1 });
        if (Object.hasOwn(n, 'then')) kids.push({ parent: n, key: 'then', role: 'rule', depth: s.depth + 1 });
      } else if (Object.hasOwn(n, 'if')) {
        kids.push({ parent: n, key: 'if', role: 'cond', depth: s.depth + 1 });
      }
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
    }
    return out;
  }

  /** Every numeric literal field of the nodes (density: scalar fields and knot coordinates; rules: the nine fields). */
  fields(withRefs = false): Field[] {
    const out: Field[] = [];
    const isNum = (x: unknown): boolean => typeof x === 'number' || (withRefs && isObj(x) && Object.hasOwn(x, 'param'));
    for (const s of this.slots()) {
      const n = (s.parent as Obj)[s.key as string] as Obj;
      if (this.format === 'density') {
        for (const k of Object.keys(n)) {
          const x = n[k];
          if (k === 'knots' && Array.isArray(x)) {
            for (const kn of x) if (Array.isArray(kn)) for (let i = 0; i < kn.length; i++) if (isNum(kn[i])) out.push({ parent: kn, key: i, int: false, refable: true });
          } else if (isNum(x)) {
            out.push({ parent: n, key: k, int: false, refable: DENSITY_REF_FIELDS.has(k) });
          }
        }
      } else {
        for (const k of Object.keys(n)) {
          if (RULE_NUMBER_FIELDS.has(k) && isNum(n[k])) out.push({ parent: n, key: k, int: RULE_INT_FIELDS.has(k), refable: true });
        }
      }
    }
    return out;
  }

  /** Every name already used as a def or tap name (density), for fresh names. */
  names(): Set<string> {
    const out = new Set<string>();
    const v = this.value;
    if (isObj(v) && isObj(own(v, 'defs'))) for (const k of Object.keys(own(v, 'defs') as Obj)) out.add(k);
    for (const s of this.slots()) {
      const n = (s.parent as Obj)[s.key as string] as Obj;
      const name = own(n, 'name');
      if (typeof name === 'string') out.add(name);
    }
    return out;
  }

  /** The defs object of a density value (created when missing and the value is an object), else undefined. */
  defs(): Obj | undefined {
    const v = this.value;
    if (!isObj(v)) return undefined;
    let d = own(v, 'defs');
    if (!isObj(d)) {
      d = {};
      define(v, 'defs', d);
    }
    return d as Obj;
  }
}

const getSlot = (s: Slot): Obj => (s.parent as Obj)[s.key as string] as Obj;
function setSlot(s: Slot | Field, v: unknown): void {
  if (Array.isArray(s.parent)) s.parent[s.key as number] = v;
  else define(s.parent, s.key as string, v);
}

/** Names that are empty, dotted, `__proto__`, `Object.prototype` members, malformed or over-long. */
const BAD_NAMES: readonly string[] = [
  '', 'a.b', '__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty', '1abc', 'a-b', 'x'.repeat(33), 'y'.repeat(300),
];
/** Numbers no tree may hold, or only in some places: −0, non-finite, beyond the literal range, extreme exponents. */
const BAD_NUMBERS: readonly number[] = [-0, NaN, Infinity, -Infinity, 1e308, -1e308, 1e9 + 1, -(1e9 + 1), 1e300, -1e200, 5e-324, 1e-300];
/** Param paths that are not targets: missing, non-numeric, outside the density / surface groups, prototype names. */
const BAD_PARAM_PATHS: readonly string[] = [
  'density.nope', 'density.noises.jag', 'density.noises.jag.wavelength', 'density.defs', 'surface.rules', 'climate.scaleMul',
  'surface.noises.depth', 'constructor', '__proto__', 'toString', '', 'density.detailAmpLo.x',
];
const TARGETS: readonly string[] = [...ALLOWED_REF_TARGETS.keys()];
const INT_TARGETS: readonly string[] = TARGETS.filter((t) => ALLOWED_REF_TARGETS.get(t)!.kind === 'int');

/** −0 never: a product or difference that gives −0 is written +0. */
const plus0 = (v: number): number => (v === 0 ? 0 : v);

/** One mutation per call; `mutate` returns false when it does not apply to this tree. */
class Mutator {
  private readonly next: () => number;
  private readonly t: Tree;
  constructor(next: () => number, t: Tree) {
    this.next = next;
    this.t = t;
  }

  private pick<T>(xs: readonly T[]): T { return xs[this.next() % xs.length]!; }
  private int(lo: number, hi: number): number { return lo + (this.next() % (hi - lo + 1)); }
  private fresh(prefix: string): string {
    const used = this.t.names();
    for (let k = 1; ; k++) if (!used.has(`${prefix}${k}`)) return `${prefix}${k}`;
  }

  /** A small valid leaf node of the format's slot role. */
  private leaf(role: Slot['role']): Obj {
    if (role === 'node') return this.next() % 2 === 0 ? { op: 'y' } : { op: 'const', v: this.int(-8, 8) };
    if (role === 'cond') return { kind: 'skyOpen' };
    return { kind: 'block', state: 'stone' };
  }

  mutate(name: MutationName): boolean {
    const t = this.t;
    const density = t.format === 'density';
    const slots = t.slots();
    const slot = slots.length > 0 ? this.pick(slots) : undefined;
    switch (name) {
      // ---------------------------------------------------------------- breaking
      case 'deleteKey': {
        if (slot === undefined) return false;
        const n = getSlot(slot);
        const keys = Object.keys(n);
        if (keys.length === 0) return false;
        delete n[this.pick(keys)];
        return true;
      }
      case 'addKey': {
        if (slot === undefined) return false;
        const key = this.pick(['extra', 'scale', 'weight', 'note', 'children', density ? 'kind' : 'op', density ? 'then' : 'x']);
        define(getSlot(slot), key, this.pick<unknown>([1, 'x', true, {}, [0], { op: 'y' }, { kind: 'skyOpen' }]));
        return true;
      }
      case 'swapOp': {
        if (slot === undefined) return false;
        const n = getSlot(slot);
        const key = density ? 'op' : 'kind';
        const choices: readonly string[] = density
          ? [...SOURCE_OPS, 'bogus', 'Add', '']
          : [...RULE_KINDS, ...CONDITION_KINDS, 'bogus', ''];
        define(n, key, this.pick(choices));
        return true;
      }
      case 'badNumber': {
        const fields = t.fields();
        const bad = this.pick(BAD_NUMBERS);
        if (fields.length === 0) {
          if (slot === undefined) return false;
          setSlot(slot, density ? { op: 'const', v: bad } : { kind: 'steep', min: bad });
          return true;
        }
        setSlot(this.pick(fields), bad);
        return true;
      }
      case 'deepNesting': {
        if (slot === undefined) return false;
        const depth = this.int(20, 200);
        let v: unknown = getSlot(slot);
        const arrays = this.next() % 4 === 0;
        for (let i = 0; i < depth; i++) {
          if (arrays) v = [v];
          else if (density) v = { op: this.pick(['neg', 'abs', 'square']), x: v };
          else v = slot.role === 'cond' ? { kind: 'not', if: v } : { kind: 'sequence', rules: [v] };
        }
        setSlot(slot, v);
        return true;
      }
      case 'wideNesting': {
        const width = this.next() % 2 === 0 ? this.int(65, 300) : this.int(300, 6000);
        if (density) {
          if (this.next() % 3 === 0) {
            const defs = t.defs();
            if (defs === undefined) return false;
            for (let i = 0; i < width && i < 2000; i++) define(defs, `w${i}`, { op: 'const', v: i });
            return true;
          }
          if (slot === undefined) return false;
          // A balanced add tree over `width` leaves (iterative pairing).
          let level: unknown[] = Array.from({ length: width }, (_, i) => (i % 2 === 0 ? { op: 'y' } : { op: 'const', v: i }));
          while (level.length > 1) {
            const up: unknown[] = [];
            for (let i = 0; i < level.length; i += 2) up.push(i + 1 < level.length ? { op: 'add', a: level[i], b: level[i + 1] } : level[i]);
            level = up;
          }
          setSlot(slot, level[0]);
          return true;
        }
        if (slot === undefined) return false;
        if (this.next() % 2 === 0) {
          const biomes = Array.from({ length: width }, () => this.pick(['plains', 'desert', 'ocean', 'beach']));
          const cond = { kind: 'biome', biomes };
          setSlot(slot, slot.role === 'cond' ? cond : { kind: 'condition', if: cond, then: getSlot(slot) });
          return true;
        }
        if (slot.role === 'cond') return false;
        setSlot(slot, { kind: 'sequence', rules: Array.from({ length: width }, () => ({ kind: 'block', state: 'stone' })) });
        return true;
      }
      case 'wrongType': {
        if (slot === undefined) return false;
        setSlot(slot, this.pick<unknown>([[], [1, 2], ['add'], 'add', 'stone', 3, -0, true, null, {}, [{ op: 'y' }]]));
        return true;
      }
      case 'badName': {
        const bad = this.pick(BAD_NAMES);
        if (density) {
          const r = this.next() % 4;
          if (r === 0 || slot === undefined) {
            // A def under the bad name, referenced from a slot (an own `__proto__` key, as JSON.parse makes it).
            const defs = t.defs();
            if (defs === undefined) return false;
            define(defs, bad, { op: 'const', v: 1 });
            if (slot !== undefined) setSlot(slot, { op: 'ref', name: bad });
            return true;
          }
          const field = this.pick(['tap', 'param', 'noise', 'col', 'ref']);
          if (field === 'tap') setSlot(slot, { op: 'tap', name: bad, x: getSlot(slot) });
          else if (field === 'param') setSlot(slot, { op: 'param', path: bad });
          else if (field === 'noise') setSlot(slot, { op: this.pick(['noise', 'noise2']), id: bad });
          else if (field === 'col') setSlot(slot, { op: 'col', field: bad });
          else setSlot(slot, { op: 'ref', name: bad });
          return true;
        }
        if (slot === undefined) return false;
        if (this.next() % 4 === 0) {
          define(getSlot(slot), bad, 1);
          return true;
        }
        if (slot.role === 'cond') {
          setSlot(slot, this.pick<Obj>([
            { kind: 'biome', biomes: ['plains', bad] },
            { kind: 'noiseThreshold', noise: bad, min: 0, max: 1 },
            { kind: 'stoneDepth', side: bad, offset: 0, addSurfaceDepth: false },
            { kind: 'steep', min: { param: bad } },
          ]));
        } else {
          setSlot(slot, { kind: 'block', state: bad });
        }
        return true;
      }
      case 'refCycle': {
        const defs = t.defs();
        if (defs === undefined) return false;
        const a = this.fresh('c'), b = `${a}x`;
        if (this.next() % 2 === 0) {
          define(defs, a, { op: 'add', a: { op: 'ref', name: b }, b: { op: 'y' } });
          define(defs, b, { op: 'neg', x: { op: 'ref', name: a } });
        } else {
          define(defs, a, { op: 'abs', x: { op: 'ref', name: a } });
        }
        if (slot !== undefined && this.next() % 2 === 0) setSlot(slot, { op: 'ref', name: a });
        return true;
      }
      case 'missingTarget': {
        const path = this.pick(BAD_PARAM_PATHS);
        if (density) {
          const r = this.next() % 3;
          if (r === 0 && slot !== undefined) setSlot(slot, { op: 'ref', name: this.fresh('missing') });
          else if (r === 1 && slot !== undefined) setSlot(slot, { op: 'param', path });
          else {
            const fields = t.fields().filter((f) => f.refable);
            if (fields.length === 0) return false;
            setSlot(this.pick(fields), this.pick<unknown>([{ param: path }, { param: path, neg: true }, { param: 3 }, { param: TARGETS[0], neg: false }, {}]));
          }
          return true;
        }
        const fields = t.fields(true);
        if (fields.length === 0) return false;
        const f = this.pick(fields);
        const nonInt = TARGETS.filter((x) => ALLOWED_REF_TARGETS.get(x)!.kind !== 'int');
        setSlot(f, this.pick<unknown>([{ param: path }, { param: path, neg: true }, { param: 7 }, { param: this.pick(nonInt), neg: false }, { neg: true }, f.int ? { param: this.pick(nonInt) } : { param: 'surface.snowline', scale: 2 }]));
        return true;
      }
      case 'knotsOverflow': {
        if (slot === undefined) return false;
        const knots = this.pick<unknown>([
          [[0, -1e9], [5e-324, 1e9]], [[0, -1e308], [1, 1e308]], [[-64, 0], [1e-300, 1e9], [320, 0]],
          [[0, { param: 'density.detailAmpLo' }], [1e-310, { param: 'density.detailAmpHi', neg: true }]],
        ]);
        const n = getSlot(slot);
        if (own(n, 'op') === 'slide') define(n, 'knots', knots);
        else setSlot(slot, { op: 'slide', x: n, knots });
        return true;
      }
      case 'knotsGrow': {
        // A slide of 64 knots (accepted: the binary segment search of a long list in the fuzz's soundness check) or
        // more (TOO_MANY_KNOTS), spread over the world's height with finite slopes.
        if (slot === undefined) return false;
        const count = this.pick([64, 65, 200, 1024]);
        const knots = Array.from({ length: count }, (_, i) => [-80 + (i * 400) / count, (i % 3) - 1]);
        const n = getSlot(slot);
        if (own(n, 'op') === 'slide') define(n, 'knots', knots);
        else setSlot(slot, { op: 'slide', x: n, knots });
        return true;
      }
      case 'airBlock': {
        const blocks = slots.filter((s) => s.role === 'rule' && own(getSlot(s), 'kind') === 'block');
        const state = this.pick(['air', 'air', 'minecraft:air', 'stone[x=1]', 'Stone', 'water']);
        if (blocks.length > 0) define(getSlot(this.pick(blocks)), 'state', state);
        else if (slot !== undefined && slot.role === 'rule') setSlot(slot, { kind: 'block', state });
        else return false;
        return true;
      }
      case 'oversized': {
        if (slot === undefined) return false;
        const n = getSlot(slot);
        switch (this.next() % 4) {
          case 0: // > 65,536 values in arrays of ≤ 1,000 items
            define(n, 'extra', Array.from({ length: 70 }, (_, i) => Array.from({ length: 1000 }, (__, j) => i + j)));
            break;
          case 1: // an array of 1,025 … 3,000 items
            define(n, 'extra', Array.from({ length: this.int(1025, 3000) }, (_, i) => i % 7));
            break;
          case 2: // a string of 257 … 2,000 units
            define(n, density ? 'name' : 'state', 'z'.repeat(this.int(257, 2000)));
            break;
          default: // a canonical text above 128 KiB
            define(n, 'extra', Array.from({ length: 600 }, (_, i) => `${i}`.padEnd(250, 'q')));
            break;
        }
        return true;
      }
      // ---------------------------------------------------------------- structure-preserving
      case 'changeLiteral': {
        const fields = t.fields();
        if (fields.length === 0) return false;
        const f = this.pick(fields);
        const v = (f.parent as Obj)[f.key as string] as number;
        let w: number;
        if (f.int || (!density && Number.isInteger(v) && f.key !== 'min' && f.key !== 'max' && f.key !== 't')) {
          w = v + this.pick([-3, -2, -1, 1, 2, 3]);
        } else if (v === 0) {
          w = this.int(-4, 4) / 4;
        } else {
          w = v * (0.5 + testFloat(this.next));
          if (Math.abs(w) < 1e9) w = Math.round(w * 1000) / 1000;
        }
        setSlot(f, plus0(w));
        return true;
      }
      case 'swapSiblings': {
        if (density) {
          const pairs = slots.map(getSlot).filter((n) => ['add', 'mul', 'min', 'max', 'rangeChoice'].includes(own(n, 'op') as string));
          if (pairs.length === 0) return false;
          const n = this.pick(pairs);
          const [ka, kb] = own(n, 'op') === 'rangeChoice' ? ['inside', 'outside'] : ['a', 'b'];
          const a = n[ka!];
          define(n, ka!, n[kb!]);
          define(n, kb!, a);
          return true;
        }
        const seqs = slots.map(getSlot).filter((n) => Array.isArray(own(n, 'rules')) && (own(n, 'rules') as unknown[]).length >= 2);
        const lists = slots.map(getSlot).filter((n) => Array.isArray(own(n, 'biomes')) && (own(n, 'biomes') as unknown[]).length >= 2);
        const arrays = [...seqs.map((n) => n['rules'] as unknown[]), ...lists.map((n) => n['biomes'] as unknown[])];
        if (arrays.length === 0) return false;
        const xs = this.pick(arrays);
        const i = this.next() % xs.length;
        let j = this.next() % xs.length;
        if (j === i) j = (i + 1) % xs.length;
        const x = xs[i];
        xs[i] = xs[j];
        xs[j] = x;
        return true;
      }
      case 'literalToParam': {
        if (density) {
          const consts = slots.filter((s) => own(getSlot(s), 'op') === 'const');
          const fields = t.fields().filter((f) => f.refable);
          const neg = this.next() % 3 === 0;
          if (consts.length > 0 && (fields.length === 0 || this.next() % 2 === 0)) {
            setSlot(this.pick(consts), { op: 'param', path: this.pick(TARGETS) });
            return true;
          }
          if (fields.length === 0) return false;
          setSlot(this.pick(fields), neg ? { param: this.pick(TARGETS), neg: true } : { param: this.pick(TARGETS) });
          return true;
        }
        const fields = t.fields();
        if (fields.length === 0) return false;
        const f = this.pick(fields);
        const path = this.pick(f.int ? INT_TARGETS : TARGETS);
        setSlot(f, this.next() % 3 === 0 ? { param: path, neg: true } : { param: path });
        return true;
      }
      case 'wrap': {
        if (slot === undefined) return false;
        const n = getSlot(slot);
        if (density) setSlot(slot, { op: 'tap', name: this.fresh('w'), x: n });
        else if (slot.role === 'cond') setSlot(slot, { kind: 'not', if: { kind: 'not', if: n } });
        else setSlot(slot, { kind: 'sequence', rules: [n] });
        return true;
      }
      case 'muteTap': {
        const taps = slots.filter((s) => own(getSlot(s), 'op') === 'tap');
        let tap: Obj;
        if (taps.length > 0) tap = getSlot(this.pick(taps));
        else {
          if (slot === undefined) return false;
          tap = { op: 'tap', name: this.fresh('m'), x: getSlot(slot) };
          setSlot(slot, tap);
        }
        define(tap, 'mute', this.pick<unknown>([0, 1, -1, -1000000, 1000000, 0.5, -10, { param: this.pick(TARGETS) }, { param: this.pick(TARGETS), neg: true }]));
        return true;
      }
      case 'addDef': {
        if (density) {
          const defs = t.defs();
          if (defs === undefined || slot === undefined) return false;
          const name = this.fresh('def');
          define(defs, name, getSlot(slot));
          setSlot(slot, { op: 'ref', name });
          return true;
        }
        const seqs = slots.map(getSlot).filter((n) => Array.isArray(own(n, 'rules')) && (own(n, 'rules') as unknown[]).length >= 1);
        if (seqs.length === 0) return false;
        const rules = this.pick(seqs)['rules'] as unknown[];
        const i = this.next() % rules.length;
        rules.splice(i + 1, 0, cloneTree(rules[i]));
        return true;
      }
    }
  }
}

/**
 * `count` mutations (default 1) of a copy of `base` (a value of `format`), each drawn from `opts.cls` or, without it,
 * from one class drawn first (breaking or preserving, one in two). A mutation that does not apply to the tree is
 * redrawn; after 16 misses the value is wrapped (density: in a tap; rules: in a sequence), which always applies.
 */
export function mutateTree(next: () => number, base: unknown, format: JsonFormat, opts: MutateOptions = {}): TreeMutation {
  const cls: MutationClass = opts.cls ?? (next() % 2 === 0 ? 'breaking' : 'preserving');
  const names = mutationsOf(format, cls);
  const tree = new Tree(base, format);
  const m = new Mutator(next, tree);
  const applied: MutationName[] = [];
  for (let c = 0; c < (opts.count ?? 1); c++) {
    let done = false;
    for (let tries = 0; tries < 16 && !done; tries++) {
      const name = names[next() % names.length]!;
      if (m.mutate(name)) { applied.push(name); done = true; }
    }
    if (!done && m.mutate('wrap')) applied.push('wrap');
  }
  return { value: tree.value, names: applied, cls };
}
