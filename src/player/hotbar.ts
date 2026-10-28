/**
 * The hotbar (SP5a spec §4.3, D9; master §4.12): nine slots, each a block type by name (`pinned` is `{}` in SP5a), a
 * fluid bucket or the empty bucket, and the active one. 1-9 select a slot, the wheel steps it (wrapping), the palette
 * assigns the active slot and MMB picks into it. Every change is stored at once in `wi.world.hotbar` as
 * `{ v: 1, active, slots }`, slots by type name, and normalised on read; the storage is injected and may be null or
 * throw (private mode, quota): the hotbar then lasts for this page. SP5b moves it into the world record.
 */
import { REGISTRY } from '../world/blocks/index';
import { displayName, PLACEABLE } from '../world/blocks/tags';
import type { Slot } from './interaction';

/** The `localStorage` key. */
export const HOTBAR_KEY = 'wi.world.hotbar';

const SLOT_COUNT = 9;
const STORED_VERSION = 1;

const block = (type: string): Slot => Object.freeze({ type, pinned: Object.freeze({}) });

/** The master's hotbar (§4.12): stone, dirt, grass, oak planks, glass, oak log, torch, water and lava buckets. */
export const DEFAULT_HOTBAR: readonly Slot[] = Object.freeze([
  block('stone'), block('dirt'), block('grass_block'), block('oak_planks'), block('glass'), block('oak_log'), block('torch'),
  Object.freeze({ fluid: 'water' as const }), Object.freeze({ fluid: 'lava' as const }),
]);

export interface Hotbar {
  readonly slots: readonly Slot[];
  /** The active slot, 0 … 8. */
  readonly active: number;
  /** Makes slot `i` active; an index outside 0 … 8 or not an integer does nothing. */
  select(i: number): void;
  /** The next (1) or previous (−1) slot, wrapping. */
  step(d: 1 | -1): void;
  /** Writes `slot` into the active slot. */
  assign(slot: Slot): void;
  /** MMB (spec §4.2): the first slot holding the type becomes active (the active one if it holds it), else the active slot takes it. */
  pick(typeName: string): void;
  /** Calls `f` after every change (the active slot or a slot's content); returns the unsubscriber. */
  subscribe(f: () => void): () => void;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The type id of a placeable type's name, or −1 (unknown, or air and the wall torch). */
function placeableType(name: unknown): number {
  if (typeof name !== 'string' || !REGISTRY.TYPE_NAMES.includes(name)) return -1;
  const t = REGISTRY.typeId(name);
  return PLACEABLE[t] === 1 ? t : -1;
}

/** A slot's `pinned`: the stored props when they are strings the type takes, else `{}` (missing, non-object or invalid). */
function normalizePinned(type: number, raw: unknown): Readonly<Record<string, string>> {
  if (!isObject(raw)) return Object.freeze({});
  const pinned: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== 'string') return Object.freeze({});
    pinned[k] = v;
  }
  try {
    REGISTRY.stateOf(type, pinned);
  } catch {
    return Object.freeze({});
  }
  return Object.freeze(pinned);
}

/** One stored slot, or null when it is malformed (the caller puts the default slot there). */
function normalizeSlot(raw: unknown): Slot | null {
  if (!isObject(raw)) return null;
  if ('type' in raw) {
    const t = placeableType(raw.type);
    return t < 0 ? null : Object.freeze({ type: raw.type as string, pinned: normalizePinned(t, raw.pinned) });
  }
  if ('fluid' in raw) return raw.fluid === 'water' || raw.fluid === 'lava' ? Object.freeze({ fluid: raw.fluid }) : null;
  if ('tool' in raw) return raw.tool === 'emptyBucket' ? Object.freeze({ tool: 'emptyBucket' as const }) : null;
  return null;
}

/**
 * The hotbar from any value: a `{ v: 1, active, slots }` object gives each of its nine slots, an unknown type name, a
 * non-placeable one or a malformed slot replaced by that position's default slot, and a missing or non-object `pinned`
 * by `{}`; an active index outside 0 … 8 becomes 0. Anything else (another version, a non-object) gives the defaults.
 */
export function normalizeHotbar(raw: unknown): { active: number; slots: Slot[] } {
  if (!isObject(raw) || raw.v !== STORED_VERSION) return { active: 0, slots: [...DEFAULT_HOTBAR] };
  const stored = Array.isArray(raw.slots) ? raw.slots : [];
  const slots: Slot[] = [];
  for (let i = 0; i < SLOT_COUNT; i++) slots.push(normalizeSlot(stored[i]) ?? DEFAULT_HOTBAR[i]!);
  const a = raw.active;
  const active = typeof a === 'number' && Number.isInteger(a) && a >= 0 && a < SLOT_COUNT ? a : 0;
  return { active, slots };
}

/** The stored hotbar, or the defaults when the storage is null or throws or the JSON is bad. */
function load(storage: Pick<Storage, 'getItem'> | null): { active: number; slots: Slot[] } {
  if (storage === null) return normalizeHotbar(null);
  try {
    const text = storage.getItem(HOTBAR_KEY);
    return normalizeHotbar(text === null ? null : JSON.parse(text));
  } catch {
    return normalizeHotbar(null);
  }
}

export function createHotbar(storage: Pick<Storage, 'getItem' | 'setItem'> | null): Hotbar {
  const { slots, active: initial } = load(storage);
  let active = initial;
  const listeners = new Set<() => void>();
  const changed = (): void => {
    if (storage !== null) {
      try {
        storage.setItem(HOTBAR_KEY, JSON.stringify({ v: STORED_VERSION, active, slots }));
      } catch {
        // The hotbar only lasts for this page then.
      }
    }
    for (const f of [...listeners]) f();
  };
  const select = (i: number): void => {
    if (!Number.isInteger(i) || i < 0 || i >= SLOT_COUNT || i === active) return;
    active = i;
    changed();
  };
  return {
    slots,
    get active() {
      return active;
    },
    select,
    step(d) {
      active = (active + d + SLOT_COUNT) % SLOT_COUNT;
      changed();
    },
    assign(slot) {
      slots[active] = slot;
      changed();
    },
    pick(typeName) {
      if (placeableType(typeName) < 0) return;
      const holds = (s: Slot): boolean => 'type' in s && s.type === typeName;
      if (holds(slots[active]!)) return;
      const i = slots.findIndex(holds);
      if (i >= 0) select(i);
      else {
        slots[active] = block(typeName);
        changed();
      }
    },
    subscribe(f) {
      listeners.add(f);
      return () => {
        listeners.delete(f);
      };
    },
  };
}

/** The name the HUD and the palette show: the block's display name ("Oak planks"), or the bucket's. */
export function slotName(slot: Slot): string {
  if ('type' in slot) return displayName(REGISTRY.typeId(slot.type));
  if ('fluid' in slot) return slot.fluid === 'water' ? 'Water bucket' : 'Lava bucket';
  return 'Empty bucket';
}
