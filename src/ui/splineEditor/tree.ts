/**
 * The spline drawer's node tree (SP2b spec §4.2): every node of the open spline with its coord and knot count
 * (model.ts splineTree), indented by depth; the open node is marked and a node a lint names carries a mark.
 * Clicking a row opens its node. DOM only.
 */
import type { KnotPath } from '../../core/spline/types';
import { el } from '../common/dom';
import type { TreeRow } from './model';

export interface SplineTreeView {
  readonly element: HTMLElement;
  /** Shows the rows; `linted` holds the node keys (`nodeKey`) that a lint names. */
  render(rows: readonly TreeRow[], current: KnotPath, linted: ReadonlySet<string>): void;
}

/** A node path as a string key ('' for the root, '7.1' for [7, 1]); also the rows' `data-node`. */
export const nodeKey = (nodePath: KnotPath): string => nodePath.join('.');

export function createSplineTreeView(onOpen: (nodePath: KnotPath) => void): SplineTreeView {
  const element = el('nav', 'sd-tree');
  element.setAttribute('aria-label', 'Spline nodes');
  let shown = '';
  return {
    element,
    render(rows, current, linted) {
      const at = nodeKey(current);
      const key = `${at}|${[...linted].join(',')}|${rows.map((r) => `${nodeKey(r.nodePath)}=${r.label}`).join('|')}`;
      if (key === shown) return;
      shown = key;
      element.replaceChildren(...rows.map((r) => {
        const k = nodeKey(r.nodePath);
        const b = el('button', `sd-node${linted.has(k) ? ' sd-node-linted' : ''}`, r.label);
        b.type = 'button';
        b.dataset['node'] = k;
        b.style.paddingLeft = `${6 + 12 * r.depth}px`;
        if (k === at) b.setAttribute('aria-current', 'true');
        if (linted.has(k)) b.title = 'a lint names a knot of this node';
        b.addEventListener('click', () => onOpen(r.nodePath));
        return b;
      }));
    },
  };
}
