/**
 * The block registry engine (SP3a spec §2.1-2.3, frozen from SP3a). `buildRegistry(defs)` numbers the states, fills
 * the per-state tables (SoA, sized MAX_STATES) and returns the lookup API. The real definitions live in `defs.ts`;
 * tests build fixture registries from their own definitions.
 *
 * Ids: types and states follow the definition order, from 0. A type's states are contiguous with its default first:
 * number the property combinations in mixed-radix order (properties in declaration order, values in kind order, the
 * last property varying fastest); with k a combination's number and d the default's, the state id is
 * `base + (k = d ? 0 : k < d ? k + 1 : k)`, and `DEFAULT_STATE[type] = base`.
 *
 * Canonical key: the bare type name without properties, else `name[p1=v1,p2=v2,…]` listing every property in
 * declaration order, values spelled as their kind value names, no spaces.
 */
import {
  COLLIDE_VALUES, FLUID_MODE_VALUES, KIND_VALUES, PASS_VALUES, PROPERTY_KINDS, SHAPE_VALUES, SOUND_VALUES, TINT_VALUES,
  type Collide, type FluidMode, type Pass, type PropertyKind, type Shape, type Sound, type Tint,
} from './kinds';

const KINDS = KIND_VALUES;
const KIND_LIST = PROPERTY_KINDS;
const PASSES = PASS_VALUES;
const SHAPES = SHAPE_VALUES;
const COLLIDES = COLLIDE_VALUES;
const FLUID_MODES = FLUID_MODE_VALUES;
const TINTS = TINT_VALUES;
const SOUNDS = SOUND_VALUES;

/** Block states are u16, at most 4096 of them; every per-state table has this length. */
export const MAX_STATES = 4096;
const FACES = 6;
const NAME_RE = /^[a-z][a-z0-9_]*$/;

/** A state's properties by name, each value spelled as its kind value name. */
export type PropValues = Readonly<Record<string, string>>;
/** A per-state table value: a constant, or a function of the state's properties. */
export type PerState<T> = T | ((props: PropValues) => T);

export interface PropertyDef {
  /** Unique within the type; matches `[a-z][a-z0-9_]*`. */
  readonly name: string;
  readonly kind: PropertyKind;
  /** One of the kind's values. */
  readonly default: string;
}

/** The per-state table values of a definition (codes in SP3a spec §2.1). */
export interface StateTables {
  /** 0 (transparent), 1 (filters) or 15 (opaque). */
  readonly opacity: PerState<0 | 1 | 15>;
  readonly pass: PerState<Pass>;
  readonly shape: PerState<Shape>;
  /** Bit i: face i is a full face (0 … 63). */
  readonly fullFaces: PerState<number>;
  /** Emitted block light, 0 … 15. */
  readonly emit: PerState<number>;
  readonly carvable: PerState<boolean>;
  readonly replaceable: PerState<boolean>;
  readonly collide: PerState<Collide>;
  readonly fluidMode: PerState<FluidMode>;
  readonly tint: PerState<Tint>;
  readonly sound: PerState<Sound>;
  /** Texture ids (u16): one for all six faces, or six in face order. */
  readonly faceTex: PerState<number | readonly number[]>;
}

export interface BlockDef extends StateTables {
  /** Matches `[a-z][a-z0-9_]*`; unique in the registry. */
  readonly name: string;
  /** In declaration order; none for a single-state type. */
  readonly props?: readonly PropertyDef[];
}

export interface BlockRegistry {
  readonly typeCount: number;
  readonly stateCount: number;
  /** Per type: the type name. */
  readonly TYPE_NAMES: readonly string[];
  /** Per type: its default state, which is also its first id. */
  readonly DEFAULT_STATE: Uint16Array;
  // Per-state tables, sized MAX_STATES (entries past stateCount are 0). Never written after the build.
  readonly STATE_TYPE: Uint16Array;
  readonly OPACITY: Uint8Array;
  readonly PASS: Uint8Array;
  readonly SHAPE: Uint8Array;
  readonly FULL_FACES: Uint8Array;
  readonly EMIT: Uint8Array;
  readonly CARVABLE: Uint8Array;
  readonly REPLACEABLE: Uint8Array;
  readonly COLLIDE: Uint8Array;
  readonly FLUID_MODE: Uint8Array;
  readonly TINT: Uint8Array;
  readonly SOUND: Uint8Array;
  /** `FACE_TEX[state·6 + face]`, MAX_STATES × 6 entries. */
  readonly FACE_TEX: Uint16Array;
  /** Type id of a name; throws for an unknown name. */
  typeId(name: string): number;
  typeName(type: number): string;
  typeProperties(type: number): readonly PropertyDef[];
  /** The state of `type` with `props`; missing props take the defaults; unknown props or values throw. */
  stateOf(type: number, props?: PropValues): number;
  /** A frozen object with every property of the state's type, in declaration order. */
  propsOf(state: number): PropValues;
  withProp(state: number, prop: string, value: string): number;
  /**
   * The state of `type` that keeps each property the target declares with the same name and the same kind; every
   * other property takes the target's default.
   */
  withType(state: number, type: number): number;
  /**
   * Turns clockwise seen from +y by ((quarterTurns mod 4) + 4) mod 4 quarter turns: facing4 and facing6 step north →
   * east → south → west per turn (up and down stay), axis swaps x ↔ z on odd turns; other kinds are unchanged.
   */
  rotateState(state: number, quarterTurns: number): number;
  /**
   * 'x' negates x (east ↔ west), 'z' negates z (north ↔ south); up and down stay; hinge flips left ↔ right on either
   * axis; axis, half, open and slabType are unchanged.
   */
  mirrorState(state: number, axis: 'x' | 'z'): number;
  stateKey(state: number): string;
  /** The state whose canonical key is `key`; throws for any other string. */
  parseStateKey(key: string): number;
}

interface TypeInfo {
  readonly name: string;
  readonly props: readonly PropertyDef[];
  readonly propIndex: ReadonlyMap<string, number>;
  readonly radix: readonly number[];
  readonly stride: readonly number[];
  readonly defaultCodes: readonly number[];
  readonly defaultCombo: number;
  readonly base: number;
  readonly count: number;
}

const fail = (message: string): never => {
  throw new Error(`buildRegistry: ${message}`);
};

function typeInfo(def: BlockDef, base: number): TypeInfo {
  if (!NAME_RE.test(def.name)) fail(`type name "${def.name}" does not match [a-z][a-z0-9_]*`);
  const props = Object.freeze((def.props ?? []).map((p) => Object.freeze({ name: p.name, kind: p.kind, default: p.default })));
  const propIndex = new Map<string, number>();
  const radix: number[] = [];
  const defaultCodes: number[] = [];
  let count = 1;
  props.forEach((p, i) => {
    if (!NAME_RE.test(p.name)) fail(`property name "${p.name}" of ${def.name} does not match [a-z][a-z0-9_]*`);
    if (propIndex.has(p.name)) fail(`duplicate property ${p.name} in ${def.name}`);
    if (!KIND_LIST.includes(p.kind)) fail(`unknown kind ${String(p.kind)} of ${def.name}.${p.name}`);
    const code = KINDS[p.kind].indexOf(p.default);
    if (code < 0) fail(`default ${p.default} of ${def.name}.${p.name} is not a ${p.kind} value`);
    propIndex.set(p.name, i);
    radix.push(KINDS[p.kind].length);
    defaultCodes.push(code);
    count *= KINDS[p.kind].length;
    if (count > MAX_STATES) throw new RangeError(`buildRegistry: ${def.name} alone has more than ${MAX_STATES} states (MAX_STATES)`);
  });
  const stride: number[] = new Array<number>(props.length);
  let defaultCombo = 0;
  for (let i = props.length - 1, s = 1; i >= 0; s *= radix[i]!, i--) {
    stride[i] = s;
    defaultCombo += defaultCodes[i]! * s;
  }
  return { name: def.name, props, propIndex, radix, stride, defaultCodes, defaultCombo, base, count };
}

const stateOfCombo = (t: TypeInfo, k: number): number =>
  t.base + (k === t.defaultCombo ? 0 : k < t.defaultCombo ? k + 1 : k);

function comboOfCodes(t: TypeInfo, codes: readonly number[]): number {
  let k = 0;
  for (let i = 0; i < codes.length; i++) k += codes[i]! * t.stride[i]!;
  return k;
}

function codesOfCombo(t: TypeInfo, k: number): number[] {
  const codes: number[] = [];
  for (let i = 0; i < t.radix.length; i++) codes.push(Math.floor(k / t.stride[i]!) % t.radix[i]!);
  return codes;
}

const perState = <T>(v: PerState<T>, props: PropValues): T =>
  typeof v === 'function' ? (v as (p: PropValues) => T)(props) : v;

function enumCode(list: readonly string[], v: unknown, field: string, key: string): number {
  const i = typeof v === 'string' ? list.indexOf(v) : -1;
  if (i < 0) fail(`${field} of ${key} is ${String(v)} (expected one of ${list.join(', ')})`);
  return i;
}

function intIn(v: unknown, lo: number, hi: number, field: string, key: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi) fail(`${field} of ${key} is ${String(v)} (expected an integer in [${lo}, ${hi}])`);
  return v as number;
}

function flag(v: unknown, field: string, key: string): number {
  if (typeof v !== 'boolean') fail(`${field} of ${key} is ${String(v)} (expected a boolean)`);
  return v ? 1 : 0;
}

export function buildRegistry(defs: readonly BlockDef[]): BlockRegistry {
  if (defs.length === 0) fail('a registry needs at least one block type');
  const types: TypeInfo[] = [];
  const typeIds = new Map<string, number>();
  let stateCount = 0;
  for (const def of defs) {
    const t = typeInfo(def, stateCount);
    if (typeIds.has(t.name)) fail(`duplicate type name ${t.name}`);
    if (stateCount + t.count > MAX_STATES) throw new RangeError(`buildRegistry: more than ${MAX_STATES} states (MAX_STATES) at ${t.name}`);
    typeIds.set(t.name, types.length);
    types.push(t);
    stateCount += t.count;
  }
  const typeCount = types.length;

  const STATE_TYPE = new Uint16Array(MAX_STATES);
  const OPACITY = new Uint8Array(MAX_STATES);
  const PASS = new Uint8Array(MAX_STATES);
  const SHAPE = new Uint8Array(MAX_STATES);
  const FULL_FACES = new Uint8Array(MAX_STATES);
  const EMIT = new Uint8Array(MAX_STATES);
  const CARVABLE = new Uint8Array(MAX_STATES);
  const REPLACEABLE = new Uint8Array(MAX_STATES);
  const COLLIDE = new Uint8Array(MAX_STATES);
  const FLUID_MODE = new Uint8Array(MAX_STATES);
  const TINT = new Uint8Array(MAX_STATES);
  const SOUND = new Uint8Array(MAX_STATES);
  const FACE_TEX = new Uint16Array(MAX_STATES * FACES);
  const DEFAULT_STATE = new Uint16Array(typeCount);
  const combo = new Uint16Array(stateCount);
  const codes: (readonly number[])[] = new Array<readonly number[]>(stateCount);
  const props: PropValues[] = new Array<PropValues>(stateCount);
  const keys: string[] = new Array<string>(stateCount);
  const keyIds = new Map<string, number>();

  types.forEach((t, ti) => {
    const def = defs[ti]!;
    DEFAULT_STATE[ti] = t.base;
    for (let k = 0; k < t.count; k++) {
      const s = stateOfCombo(t, k);
      const c = codesOfCombo(t, k);
      const p: Record<string, string> = {};
      t.props.forEach((pd, i) => { p[pd.name] = KINDS[pd.kind][c[i]!]!; });
      const key = t.props.length === 0 ? t.name : `${t.name}[${t.props.map((pd) => `${pd.name}=${p[pd.name]!}`).join(',')}]`;
      STATE_TYPE[s] = ti;
      combo[s] = k;
      codes[s] = Object.freeze(c);
      props[s] = Object.freeze(p);
      keys[s] = key;
      keyIds.set(key, s);

      const opacity = perState(def.opacity, props[s]!);
      if (opacity !== 0 && opacity !== 1 && opacity !== 15) fail(`opacity of ${key} is ${String(opacity)} (expected 0, 1 or 15)`);
      OPACITY[s] = opacity;
      PASS[s] = enumCode(PASSES, perState(def.pass, props[s]!), 'pass', key);
      SHAPE[s] = enumCode(SHAPES, perState(def.shape, props[s]!), 'shape', key);
      FULL_FACES[s] = intIn(perState(def.fullFaces, props[s]!), 0, 63, 'fullFaces', key);
      EMIT[s] = intIn(perState(def.emit, props[s]!), 0, 15, 'emit', key);
      CARVABLE[s] = flag(perState(def.carvable, props[s]!), 'carvable', key);
      REPLACEABLE[s] = flag(perState(def.replaceable, props[s]!), 'replaceable', key);
      COLLIDE[s] = enumCode(COLLIDES, perState(def.collide, props[s]!), 'collide', key);
      FLUID_MODE[s] = enumCode(FLUID_MODES, perState(def.fluidMode, props[s]!), 'fluidMode', key);
      TINT[s] = enumCode(TINTS, perState(def.tint, props[s]!), 'tint', key);
      SOUND[s] = enumCode(SOUNDS, perState(def.sound, props[s]!), 'sound', key);
      const tex = perState(def.faceTex, props[s]!);
      if (typeof tex === 'number') {
        const v = intIn(tex, 0, 65535, 'faceTex', key);
        for (let f = 0; f < FACES; f++) FACE_TEX[s * FACES + f] = v;
      } else {
        if (!Array.isArray(tex) || tex.length !== FACES) fail(`faceTex of ${key} must be a number or ${FACES} numbers`);
        for (let f = 0; f < FACES; f++) FACE_TEX[s * FACES + f] = intIn(tex[f], 0, 65535, 'faceTex', key);
      }
    }
  });

  const typeOfState = (s: number): TypeInfo => types[STATE_TYPE[s]!]!;
  const stateOfCodes = (t: TypeInfo, c: readonly number[]): number => stateOfCombo(t, comboOfCodes(t, c));

  // Rotation (q = 0 … 3) and mirror tables, built once.
  const turn = (s: number): number => {
    const t = typeOfState(s);
    const c = codes[s]!.map((v, i) => {
      const kind = t.props[i]!.kind;
      if ((kind === 'facing4' || kind === 'facing6') && v < 4) return (v + 1) & 3;
      if (kind === 'axis') return v === 1 ? v : 2 - v; // x ↔ z
      return v;
    });
    return stateOfCodes(t, c);
  };
  const mirror = (s: number, swapA: number, swapB: number): number => {
    const t = typeOfState(s);
    const c = codes[s]!.map((v, i) => {
      const kind = t.props[i]!.kind;
      if (kind === 'facing4' || kind === 'facing6') return v === swapA ? swapB : v === swapB ? swapA : v;
      if (kind === 'hinge') return 1 - v;
      return v;
    });
    return stateOfCodes(t, c);
  };
  const rotations = new Uint16Array(4 * stateCount);
  const mirrorX = new Uint16Array(stateCount);
  const mirrorZ = new Uint16Array(stateCount);
  for (let s = 0; s < stateCount; s++) {
    rotations[s] = s;
    for (let q = 1; q < 4; q++) rotations[q * stateCount + s] = turn(rotations[(q - 1) * stateCount + s]!);
    mirrorX[s] = mirror(s, 1, 3);
    mirrorZ[s] = mirror(s, 0, 2);
  }

  const checkState = (s: number, fn: string): void => {
    if (!Number.isInteger(s) || s < 0 || s >= stateCount) throw new RangeError(`${fn}: no state ${s} (stateCount ${stateCount})`);
  };
  const checkType = (t: number, fn: string): TypeInfo => {
    if (!Number.isInteger(t) || t < 0 || t >= typeCount) throw new RangeError(`${fn}: no type ${t} (typeCount ${typeCount})`);
    return types[t]!;
  };
  const valueCode = (t: TypeInfo, prop: string, value: string, fn: string): [number, number] => {
    const i = t.propIndex.get(prop);
    if (i === undefined) throw new Error(`${fn}: ${t.name} has no property ${prop}`);
    const kind = t.props[i]!.kind;
    const code = KINDS[kind].indexOf(value);
    if (code < 0) throw new Error(`${fn}: ${value} is not a value of ${t.name}.${prop} (${kind})`);
    return [i, code];
  };

  const TYPE_NAMES = Object.freeze(types.map((t) => t.name));

  return Object.freeze({
    typeCount, stateCount, TYPE_NAMES, DEFAULT_STATE,
    STATE_TYPE, OPACITY, PASS, SHAPE, FULL_FACES, EMIT, CARVABLE, REPLACEABLE, COLLIDE, FLUID_MODE, TINT, SOUND, FACE_TEX,
    typeId(name: string): number {
      const t = typeIds.get(name);
      if (t === undefined) throw new Error(`typeId: unknown block type ${name}`);
      return t;
    },
    typeName(type: number): string {
      return checkType(type, 'typeName').name;
    },
    typeProperties(type: number): readonly PropertyDef[] {
      return checkType(type, 'typeProperties').props;
    },
    stateOf(type: number, p: PropValues = {}): number {
      const t = checkType(type, 'stateOf');
      const c = t.defaultCodes.slice();
      for (const name of Object.keys(p)) {
        const [i, code] = valueCode(t, name, p[name]!, 'stateOf');
        c[i] = code;
      }
      return stateOfCodes(t, c);
    },
    propsOf(state: number): PropValues {
      checkState(state, 'propsOf');
      return props[state]!;
    },
    withProp(state: number, prop: string, value: string): number {
      checkState(state, 'withProp');
      const t = typeOfState(state);
      const [i, code] = valueCode(t, prop, value, 'withProp');
      return stateOfCombo(t, combo[state]! + (code - codes[state]![i]!) * t.stride[i]!);
    },
    withType(state: number, type: number): number {
      checkState(state, 'withType');
      const target = checkType(type, 'withType');
      const source = typeOfState(state);
      const c = target.props.map((pd, j) => {
        const i = source.propIndex.get(pd.name);
        return i !== undefined && source.props[i]!.kind === pd.kind ? codes[state]![i]! : target.defaultCodes[j]!;
      });
      return stateOfCodes(target, c);
    },
    rotateState(state: number, quarterTurns: number): number {
      checkState(state, 'rotateState');
      if (!Number.isInteger(quarterTurns)) throw new RangeError(`rotateState: quarterTurns ${quarterTurns} is not an integer`);
      const q = ((quarterTurns % 4) + 4) % 4;
      return rotations[q * stateCount + state]!;
    },
    mirrorState(state: number, axis: 'x' | 'z'): number {
      checkState(state, 'mirrorState');
      if (axis === 'x') return mirrorX[state]!;
      if (axis === 'z') return mirrorZ[state]!;
      throw new Error(`mirrorState: axis must be 'x' or 'z', not ${String(axis)}`);
    },
    stateKey(state: number): string {
      checkState(state, 'stateKey');
      return keys[state]!;
    },
    parseStateKey(key: string): number {
      const s = keyIds.get(key);
      if (s === undefined) throw new Error(`parseStateKey: ${JSON.stringify(key)} is not the canonical state key of a registered state`);
      return s;
    },
  });
}
