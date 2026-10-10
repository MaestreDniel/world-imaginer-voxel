/**
 * The node form's "value at the hover" (SP3d spec §3.6, D17): the selected node's value at the hovered voxel, asked of
 * the workers with one `fieldProbe` job (§5.3), as the pure stream of the Voxels mode's rule readout
 * (`createRuleReadout`, `ui/crossSection/voxels.ts`):
 * - one probe in flight; the latest hovered (voxel, node) waits in one slot and wins;
 * - a reply is shown only when its key (session epoch, voxel, field, root, path) is still the current one;
 * - `JobCancelled` at the same epoch asks again; any other error is shown as `failed: <message>` and kept as that key's
 *   answer (not retried at that epoch);
 * - a value is printed by `formatSliceValue` (so a non-finite value reads `NaN`, `+∞` or `−∞`); a rule node's value is
 *   its mask: `yes` (on the voxel's rule path, or the condition holds), `no`, or `n/a` (air or water: no surface run).
 * `epoch()` is the session epoch of the draft the pool's last resolved configure holds (`DriverStatus.sessionEpoch`), or
 * null before one: the probe then runs on that draft, and `refresh()` (called on every status change) asks again for
 * the voxel still hovered once the epoch moves.
 */
import { JobCancelled, type WorkerPool } from '../../engine/workerPool';
import type { ProbeField } from '../../gen/inspect/fieldSlice';
import type { TreeLeaf } from './editorModel';
import type { Selection } from './model';
import { formatSliceValue, RULE_NA } from './sliceModel';

/** What is probed: the field, the tree (root) and the node path inside it. */
export interface HoverTarget {
  readonly field: ProbeField;
  readonly leaf: TreeLeaf;
  readonly path: string;
}

/** A voxel in blocks (integers: the map hover's block at the slice's y, or a slice sample's voxel). */
export interface HoverVoxel {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** A probe's key: a reply is shown only while it is the current one. */
export interface HoverKey extends HoverTarget, HoverVoxel {
  readonly epoch: number;
}

export const sameHoverKey = (a: HoverKey, b: HoverKey): boolean =>
  a.epoch === b.epoch && a.x === b.x && a.y === b.y && a.z === b.z && a.field === b.field && a.leaf === b.leaf && a.path === b.path;

/** The form's target for a selection: a density node's value (`node`, the root included), a rule node's or condition's mask (`rule`). */
export function hoverTarget(sel: Selection): HoverTarget {
  return { field: sel.leaf === 'density.defs' ? 'node' : 'rule', leaf: sel.leaf, path: sel.path };
}

/** The text shown while the hovered key's probe is queued or in flight. */
export const HOVER_WAITING = '…';

/** A probed value as the form shows it. */
export function hoverValueText(field: ProbeField, v: number): string {
  if (field !== 'rule') return formatSliceValue(v);
  return v === 1 ? 'yes' : v === 0 ? 'no' : v === RULE_NA ? 'n/a' : formatSliceValue(v);
}

export interface HoverModel {
  /**
   * The pointer is over `voxel` with `target` selected (either null: nothing is hovered). Returns the text to show at
   * once: the answer (or the failure) when this key was answered, HOVER_WAITING while its probe is queued or in flight,
   * and '' when nothing is hovered or no configure has resolved yet.
   */
  hover(voxel: HoverVoxel | null, target: HoverTarget | null): string;
  /** The epoch may have moved: the last hover again, at the current epoch (the same return as `hover`). */
  refresh(): string;
}

/**
 * The stream: `pool.fieldProbe` at its default priority (−1, the point priority); `show(key, text)` reports an answer
 * for the key still current.
 */
export function createHoverModel(pool: Pick<WorkerPool, 'fieldProbe'>, epoch: () => number | null,
  show: (key: HoverKey, text: string) => void): HoverModel {
  let busy: HoverKey | null = null;
  let next: HoverKey | null = null;
  let current: HoverKey | null = null;
  let answered: { readonly key: HoverKey; readonly text: string } | null = null;
  let last: { readonly voxel: HoverVoxel | null; readonly target: HoverTarget | null } = { voxel: null, target: null };
  const live = (key: HoverKey): boolean => current !== null && sameHoverKey(current, key) && key.epoch === epoch();

  const answer = (key: HoverKey, text: string) => {
    answered = { key, text };
    if (live(key)) show(key, text);
  };

  const run = (key: HoverKey) => {
    busy = key;
    pool.fieldProbe({ field: key.field, path: key.path, x: key.x, y: key.y, z: key.z }).then((v) => {
      if (key.epoch !== epoch()) return;
      answer(key, hoverValueText(key.field, v));
    }, (e: unknown) => {
      if (key.epoch !== epoch()) return;
      if (e instanceof JobCancelled) {
        if (live(key)) next ??= key;
        return;
      }
      // Kept as an answer is, so the pointer moving inside the failed voxel does not probe it again at this epoch.
      answer(key, `failed: ${e instanceof Error ? e.message : String(e)}`);
    }).finally(() => {
      busy = null;
      const n = next;
      next = null;
      if (n !== null && live(n)) run(n);
    });
  };

  const hover = (voxel: HoverVoxel | null, target: HoverTarget | null): string => {
    last = { voxel, target };
    const e = epoch();
    if (voxel === null || target === null || e === null) {
      current = null;
      next = null;
      return '';
    }
    const key: HoverKey = { epoch: e, x: voxel.x, y: voxel.y, z: voxel.z, field: target.field, leaf: target.leaf, path: target.path };
    current = key;
    if (answered !== null && sameHoverKey(answered.key, key)) {
      next = null;
      return answered.text;
    }
    if (busy === null) run(key);
    else next = sameHoverKey(busy, key) ? null : key;
    return HOVER_WAITING;
  };

  return {
    hover,
    refresh: () => hover(last.voxel, last.target),
  };
}
