/**
 * The routing of a map click (SP3d spec §3.7), pure and unit-tested. Today's rules (SP2b spec §4.5) hold while
 * the Density tab is not shown: an armed cut tool takes the click, and a finished line opens the Cross-section
 * tab; a click near the line opens Cross-section; any other click sets the pin. While Density is shown (the drawer
 * open on its tab) a finished cut line keeps Density shown (it only sets the line its vertical plane follows), a
 * click near the line does not open Cross-section, and on the horizontal plane a click that is not the cut tool's
 * sets the plane's centre instead of the pin.
 */
import type { DrawerTabId } from './layout';

/** The Density tab's slice plane (SP3d spec §4.2): along the cut line, or XZ at a y. */
export type SlicePlane = 'vertical' | 'horizontal';

export interface MapClick {
  /** The drawer tab on screen; null while the drawer is closed. */
  readonly drawerTab: DrawerTabId | null;
  /** The Density tab's plane (it matters only while Density is shown). */
  readonly plane: SlicePlane;
  /** The click is within the hit distance of the cut line (false when there is no line). */
  readonly nearLine: boolean;
  /** The cut-line tool waits for A or B. */
  readonly cutArmed: boolean;
}

export type MapClickAction =
  /** The cut tool takes the click; a line it finishes opens the Cross-section tab when `openSection`. */
  | { readonly kind: 'cut'; readonly openSection: boolean }
  /** Open the drawer on the Cross-section tab. */
  | { readonly kind: 'openSection' }
  /** Set the horizontal plane's centre. */
  | { readonly kind: 'centre' }
  /** Set the pin. */
  | { readonly kind: 'pin' };

export function mapClickAction(c: MapClick): MapClickAction {
  const density = c.drawerTab === 'density';
  if (c.cutArmed) return { kind: 'cut', openSection: !density };
  if (density) return c.plane === 'horizontal' ? { kind: 'centre' } : { kind: 'pin' };
  return c.nearLine ? { kind: 'openSection' } : { kind: 'pin' };
}
