/**
 * A saved world's places (SP5b spec §3.7, D12): pure, over the `state` record's `places`. Add, edit and remove, the
 * proposed name ("Place N (x, y, z)"), at most `MAX_PLACES` places and names of at most `MAX_NAME` characters, as the
 * §2.1 normaliser reads them back. Every change hands a new list object, never one changed in place: the autosave's
 * state parts compare the places by identity (`createStateParts`; rulings R9), and the subscribers are told.
 */
import { MAX_NAME, MAX_PLACES, type Place } from '../../persist/saves';

/** D12's eight colours, by a place's `colour` index: red, orange, yellow, green, blue, purple, pink, light grey. */
export const PLACE_COLOURS = ['#e5534b', '#e0a030', '#e8d44d', '#57ab5a', '#4aa3df', '#986ee2', '#e275ad', '#dddddd'] as const;

/** B, or "+ Add at the pin", with `MAX_PLACES` places: no dialog opens (D12). */
export const PLACES_FULL_NOTICE = `A world holds at most ${MAX_PLACES} places`;
export const PLACES_FULL_MS = 4000;
/** A place kept by the dialog's Save (D12). */
export const PLACE_SAVED_NOTICE = 'Place saved';
export const PLACE_SAVED_MS = 1500;

/** The dialog's proposal: N the world's place count + 1, the position rounded down (the HUD prints one decimal). */
export function proposedPlaceName(count: number, x: number, y: number, z: number): string {
  return `Place ${count + 1} (${Math.floor(x)}, ${Math.floor(y)}, ${Math.floor(z)})`;
}

export interface Places {
  /** The places in the order saved; a new array after every change. */
  readonly list: readonly Place[];
  /** Keeps a place with a new id, its name trimmed and cut (empty: the proposal); 'full' at `MAX_PLACES`. */
  add(p: Omit<Place, 'id'>): Place | 'full';
  /** Renames and recolours a place (an empty name keeps its name); an unknown id changes nothing. */
  edit(id: string, name: string, colour: number): void;
  /** Removes a place and returns it; null for an unknown id. */
  remove(id: string): Place | null;
  /** `f` after every change; returns the unsubscribe. */
  subscribe(f: () => void): () => void;
}

/** A typed name trimmed and cut to `MAX_NAME` characters (code points, as the normaliser counts them). */
const cut = (name: string): string => Array.from(name.trim()).slice(0, MAX_NAME).join('');

/** A colour index 0-7; anything else is red, so the normaliser never drops the place for it. */
const colourOf = (c: number): number => (Number.isInteger(c) && c >= 0 && c < PLACE_COLOURS.length ? c : 0);

export function createPlaces(initial: readonly Place[], newId: () => string): Places {
  let list: readonly Place[] = initial.slice();
  const subscribers = new Set<() => void>();
  const changed = (next: readonly Place[]): void => {
    list = next;
    for (const f of [...subscribers]) f();
  };
  return {
    get list() {
      return list;
    },
    add(p) {
      if (list.length >= MAX_PLACES) return 'full';
      const name = cut(p.name);
      const place: Place = {
        id: newId(), name: name === '' ? proposedPlaceName(list.length, p.x, p.y, p.z) : name, colour: colourOf(p.colour),
        x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch,
      };
      changed([...list, place]);
      return place;
    },
    edit(id, name, colour) {
      const i = list.findIndex((p) => p.id === id);
      if (i < 0) return;
      const old = list[i]!;
      const typed = cut(name);
      const next = list.slice();
      next[i] = { ...old, name: typed === '' ? old.name : typed, colour: colourOf(colour) };
      changed(next);
    },
    remove(id) {
      const place = list.find((p) => p.id === id);
      if (place === undefined) return null;
      changed(list.filter((p) => p !== place));
      return place;
    },
    subscribe(f) {
      subscribers.add(f);
      return () => { subscribers.delete(f); };
    },
  };
}
