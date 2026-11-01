/**
 * The reminder on the map's disabled controls (SP5c spec §7.3, D19): while a saved world's modification mode is off,
 * every editor's `setEditable(false)` disables its terrain controls, and hovering one shows "Enable 'Modify terrain' to
 * edit here". A browser shows the title of the nearest titled ancestor of the hovered element (and a disabled control may
 * raise no mouse event), so the tip sits on each disabled control's enabled wrapper, or after the control's own title
 * when it has one. Editable again, the attribute is removed (not set to '', which would hide every ancestor's title) or
 * the own title is given back. `?map` and unsaved worlds never call `setEditable(false)`, so they never show it.
 */

/** The reminder's text. */
export const MODE_OFF_TIP = "Enable 'Modify terrain' to edit here";

/**
 * Puts the reminder on `el` while not `editable`: the title `MODE_OFF_TIP`, or, with `own` (the element's own title),
 * `own` followed by a line with it. Editable: no title attribute, or `own` back.
 */
export function setModeTip(el: HTMLElement, editable: boolean, own?: string): void {
  if (!editable) el.title = own === undefined ? MODE_OFF_TIP : `${own}\n${MODE_OFF_TIP}`;
  else if (own === undefined) el.removeAttribute('title');
  else el.title = own;
}
