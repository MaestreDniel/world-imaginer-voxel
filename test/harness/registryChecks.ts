/**
 * The round-trip part of metric M1 (SP3a spec §2.4, master §6.4 M1): over every state of a registry, four quarter
 * turns and two mirrors per axis are the identity, `stateOf(propsOf(s))`, `parseStateKey(stateKey(s))` and a
 * `withProp` round trip through every value of every property give the state back, and each type's states are
 * contiguous from its default. One message per failure; a method that throws counts as one failure of that state.
 */
import { KIND_VALUES } from '../../src/world/blocks/kinds';
import { MAX_STATES, type BlockRegistry } from '../../src/world/blocks/registry';

function stateFailures(reg: BlockRegistry, s: number): string[] {
  const out: string[] = [];
  const key = reg.stateKey(s);
  const at = `${key} (id ${s})`;
  let r = s;
  for (let i = 0; i < 4; i++) r = reg.rotateState(r, 1);
  if (r !== s) out.push(`${at}: rotateState(·, 1) four times = ${r}`);
  for (const axis of ['x', 'z'] as const) {
    const m = reg.mirrorState(reg.mirrorState(s, axis), axis);
    if (m !== s) out.push(`${at}: mirrorState(·, '${axis}') twice = ${m}`);
  }
  const type = reg.STATE_TYPE[s]!;
  const props = reg.propsOf(s);
  const back = reg.stateOf(type, props);
  if (back !== s) out.push(`${at}: stateOf(propsOf) = ${back}`);
  const parsed = reg.parseStateKey(key);
  if (parsed !== s) out.push(`${at}: parseStateKey(stateKey) = ${parsed}`);
  for (const p of reg.typeProperties(type)) {
    for (const v of KIND_VALUES[p.kind]) {
      const t = reg.withProp(s, p.name, v);
      const tp = reg.propsOf(t);
      const others = Object.keys(props).every((n) => n === p.name || tp[n] === props[n]);
      if (reg.STATE_TYPE[t] !== type || tp[p.name] !== v || !others) out.push(`${at}: withProp(${p.name}=${v}) = ${t}`);
      const undo = reg.withProp(t, p.name, props[p.name]!);
      if (undo !== s) out.push(`${at}: withProp(${p.name}=${v}) then back = ${undo}`);
    }
  }
  return out;
}

export function registryRoundTripFailures(reg: BlockRegistry): string[] {
  const n = reg.stateCount;
  if (!Number.isInteger(n) || n < 1 || n > MAX_STATES) return [`stateCount ${n} outside 1 … ${MAX_STATES}`];
  const out: string[] = [];
  for (let t = 0; t < reg.typeCount; t++) {
    const base = reg.DEFAULT_STATE[t]!;
    let end = base;
    while (end < n && reg.STATE_TYPE[end] === t) end++;
    let count = 0;
    for (let s = 0; s < n; s++) if (reg.STATE_TYPE[s] === t) count++;
    if (count !== end - base || count === 0) out.push(`type ${reg.TYPE_NAMES[t]}: its states are not contiguous from its default ${base}`);
  }
  for (let s = 0; s < n; s++) {
    try {
      out.push(...stateFailures(reg, s));
    } catch (e) {
      out.push(`state ${s}: threw ${String(e)}`);
    }
  }
  return out;
}
