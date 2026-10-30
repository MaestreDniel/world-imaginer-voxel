/**
 * The Places tab of a saved world's map (SP5b spec §3.7, D13): the world's places in the order saved, each "● name" in
 * its colour with ↗ (the teleport to its exact pose), ✎ (the name and D12's eight colours inline, Save/Cancel; Enter
 * saves and Esc cancels in the name field, Esc consumed so the tool's Esc does not close the drawer) and 🗑 (deleted at
 * once, "Deleted 'name'"). Below, "+ Add at the pin", enabled once the map has a pin (a Shift+click), read at the mount
 * and at each pin callback; it hands the pin's x and z to the page, which asks the column's ground and opens B's dialog.
 * The list is rebuilt at every change of the places. Text only through `textContent`; no browser dialog.
 */
import type { Place } from '../../persist/saves';
import { el } from '../common/dom';
import type { Notices } from '../common/notice';
import { COLOUR_NAMES } from '../world/placeDialog';
import { PLACE_COLOURS, type Places } from '../world/places';

export interface PlacesTabOptions {
  readonly places: Places;
  /** ↗: the camera to the place's exact pose (`Teleport.toPlace`, through the overlay, which closes a full-screen map). */
  teleport(p: Place): void;
  /** The map's pin (`MapTool.pin`, `onPin`). */
  readonly pin: {
    get(): readonly [number, number] | null;
    subscribe(f: (p: readonly [number, number] | null) => void): () => void;
  };
  /** "+ Add at the pin": the page's dialog for the pin's column on its ground. */
  addAt(x: number, z: number): void;
  readonly notices: Pick<Notices, 'show'>;
}

/** How long "Deleted 'name'" stays. */
const DELETED_MS = 4000;
/** An empty list's hint. */
const EMPTY_TEXT = 'No places yet: B saves where you are, or set a pin with Shift+click.';

const button = (cls: string, text: string, label: string): HTMLButtonElement => {
  const b = el('button', cls, text);
  b.type = 'button';
  b.setAttribute('aria-label', label);
  b.title = label;
  return b;
};

export function mountPlacesTab(host: HTMLElement, o: PlacesTabOptions): { dispose(): void } {
  const root = el('div', 'places-tab');
  const list = el('ul', 'places-list');
  list.id = 'places-list';
  list.style.listStyle = 'none';
  list.style.padding = '0';
  list.style.margin = '0';
  const empty = el('p', 'places-empty', EMPTY_TEXT);
  empty.id = 'places-empty';
  const add = el('button', 'places-add', '+ Add at the pin');
  add.id = 'places-add';
  add.type = 'button';
  const legend = el('p', 'places-legend', '↗ teleport · ✎ name and colour · 🗑 delete');
  root.append(list, empty, add, legend);
  host.append(root);

  /** The place being edited (its id), with the typed name and the chosen colour; null when no row is edited. */
  let editing: { readonly id: string; name: string; colour: number } | null = null;

  const dotOf = (colour: number): HTMLElement => {
    const dot = el('span', 'place-dot', '●');
    dot.style.color = PLACE_COLOURS[colour] ?? PLACE_COLOURS[0];
    dot.setAttribute('aria-hidden', 'true');
    return dot;
  };

  /** A row as listed: "● name ↗ ✎ 🗑". */
  const viewRow = (p: Place): HTMLElement => {
    const row = el('li', 'place-row');
    row.dataset['id'] = p.id;
    const go = button('place-go', '↗', `Teleport to ${p.name}`);
    go.addEventListener('click', () => o.teleport(p));
    const edit = button('place-edit', '✎', `Edit ${p.name}`);
    edit.addEventListener('click', () => {
      editing = { id: p.id, name: p.name, colour: p.colour };
      render();
      const field = list.querySelector('input');
      field?.focus();
      field?.select();
    });
    const del = button('place-delete', '🗑', `Delete ${p.name}`);
    del.addEventListener('click', () => {
      const gone = o.places.remove(p.id);
      if (gone !== null) o.notices.show(`Deleted '${gone.name}'`, { timeoutMs: DELETED_MS });
    });
    row.append(dotOf(p.colour), ' ', el('span', 'place-name', p.name), ' ', go, edit, del);
    return row;
  };

  /** A row being edited: the name, the eight colours (the chosen one pressed, with a white rim), Save and Cancel. */
  const editRow = (p: Place, e: { readonly id: string; name: string; colour: number }): HTMLElement => {
    const row = el('li', 'place-row place-row-editing');
    row.dataset['id'] = p.id;
    const name = el('input', 'place-edit-name');
    name.type = 'text';
    name.value = e.name;
    name.setAttribute('aria-label', 'Place name');
    name.addEventListener('input', () => { e.name = name.value; });
    const swatches = PLACE_COLOURS.map((c, i) => {
      const b = el('button', 'place-swatch');
      b.type = 'button';
      b.dataset['colour'] = String(i);
      b.style.background = c;
      b.style.width = '20px';
      b.style.height = '20px';
      b.style.padding = '0';
      b.setAttribute('aria-label', COLOUR_NAMES[c]);
      b.addEventListener('click', () => {
        e.colour = i;
        pressSwatches();
        dot.style.color = c;
      });
      return b;
    });
    const dot = dotOf(e.colour);
    const pressSwatches = (): void => {
      swatches.forEach((b, j) => {
        b.setAttribute('aria-pressed', String(j === e.colour));
        b.style.border = j === e.colour ? '2px solid #fff' : '2px solid transparent';
      });
    };
    pressSwatches();
    const save = (): void => {
      editing = null;
      // The model trims and cuts the name (an empty one keeps the old name) and its change rebuilds the list; the render
      // after it covers a place removed meanwhile, which changes nothing.
      o.places.edit(e.id, name.value, e.colour);
      render();
    };
    const cancel = (): void => {
      editing = null;
      render();
    };
    name.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        save();
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        cancel();
      }
    });
    const saveButton = button('place-edit-save', 'Save', 'Save');
    saveButton.addEventListener('click', save);
    const cancelButton = button('place-edit-cancel', 'Cancel', 'Cancel');
    cancelButton.addEventListener('click', cancel);
    const colours = el('span', 'place-swatches');
    colours.append(...swatches);
    row.append(dot, ' ', name, colours, saveButton, cancelButton);
    return row;
  };

  function render(): void {
    const places = o.places.list;
    // A place deleted while it was being edited ends the edit.
    if (editing !== null && !places.some((p) => p.id === editing!.id)) editing = null;
    list.replaceChildren(...places.map((p) => (editing !== null && editing.id === p.id ? editRow(p, editing) : viewRow(p))));
    empty.hidden = places.length > 0;
  }

  const syncAdd = (pin: readonly [number, number] | null): void => {
    add.disabled = pin === null;
    add.title = pin === null ? 'Shift+click the map to set a pin' : '';
  };
  add.addEventListener('click', () => {
    const pin = o.pin.get();
    if (pin !== null) o.addAt(pin[0], pin[1]);
  });

  render();
  syncAdd(o.pin.get());
  const offPin = o.pin.subscribe(syncAdd);
  const offPlaces = o.places.subscribe(render);
  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      offPin();
      offPlaces();
      root.remove();
    },
  };
}
