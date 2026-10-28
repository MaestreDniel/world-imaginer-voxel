/**
 * G2's edit latency (SP5a spec §4.6, §6.2, D26): from an edit's post to the frame its column's new mesh is shown.
 *
 * `posted` opens a sample at the sim's reply: the post time, the reply time, the edited column (the first edit's, a
 * colKey), the reply's dirty columns and the sim's relight and edit figures. A column's reveal counts for a sample only
 * after its own `staged` (the coordinator's `onEditStaged`: a payload issued at or after the latest `markEdited`), since
 * `onColumnRevealed` carries no seq and a payload staged before the edit can still reveal after it (ruling R14). The
 * edited column's first counted reveal records `visible` (from the post), `issueToStaged` (its staged time minus the
 * reply's) and `stagedToShown` (its reveal minus its staged time); the last dirty column's records `allVisible`.
 * `reply` (reply − post), `relight` and `edit` are recorded at `posted`. Each figure goes into its own preallocated
 * ring of `capacity` values (the oldest overwritten), so the arrays `samples` returns may differ in length: a dirty
 * column that is never meshed again (one the coordinator does not keep meshed) leaves its sample without `allVisible`.
 * `count` is the number of `visible` samples recorded.
 *
 * At most `PENDING` samples wait for their reveals (the oldest is dropped by a newer one), each tracking at most
 * `MAX_TRACKED` columns, the edited one first: a single-voxel edit dirties at most the 5 × 5 around it (§2.6).
 */
import { colKey } from '../../core/coords';
import { percentile } from '../../render/frameTiming';

/** Samples waiting for their reveals. */
const PENDING = 64;
/** Columns tracked per sample: the edited one, then the other dirty ones. */
const MAX_TRACKED = 32;

export interface EditLatencySamples {
  readonly visible: Float64Array;
  readonly allVisible: Float64Array;
  readonly reply: Float64Array;
  readonly issueToStaged: Float64Array;
  readonly stagedToShown: Float64Array;
  readonly relight: Float64Array;
  readonly edit: Float64Array;
}

export interface EditLatency {
  /** A sample opened at the sim's reply (ms on the page's clock); `edited` and `dirty` are colKeys. */
  posted(tPost: number, tReply: number, edited: number, dirty: ArrayLike<number>, relightMs: number, editMs: number): void;
  /** The coordinator staged a payload of (cx, cz) issued at or after its latest `markEdited`. */
  staged(cx: number, cz: number, t: number): void;
  /** The renderer revealed (cx, cz) (`onColumnRevealed`). */
  revealed(cx: number, cz: number, t: number): void;
  /** The nearest-rank p95 of the `visible` ring; NaN before a sample. */
  visibleP95(): number;
  /** The nearest-rank p95 of the `allVisible` ring; NaN before a sample. */
  allVisibleP95(): number;
  /** The `visible` samples recorded so far. */
  readonly count: number;
  /** Each ring's values, oldest first (copies). */
  samples(): EditLatencySamples;
}

/** A ring of `capacity` values with a cached p95. */
function ring(capacity: number) {
  const values = new Float64Array(capacity);
  let n = 0;
  let p95 = Number.NaN;
  let p95At = 0;
  return {
    push(v: number): void {
      values[n % capacity] = v;
      n++;
    },
    get n() {
      return n;
    },
    p95(): number {
      if (p95At !== n) {
        p95 = percentile(values.subarray(0, Math.min(n, capacity)), 95);
        p95At = n;
      }
      return p95;
    },
    copy(): Float64Array {
      if (n <= capacity) return values.slice(0, n);
      const out = new Float64Array(capacity);
      const w = n % capacity;
      out.set(values.subarray(w), 0);
      out.set(values.subarray(0, w), capacity - w);
      return out;
    },
  };
}

export function createEditLatency(capacity = 2048): EditLatency {
  if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError(`createEditLatency: capacity ${capacity} is not a positive integer`);
  const visible = ring(capacity);
  const allVisible = ring(capacity);
  const reply = ring(capacity);
  const issueToStaged = ring(capacity);
  const stagedToShown = ring(capacity);
  const relight = ring(capacity);
  const edit = ring(capacity);

  // The pending samples, slot i's columns at [i·MAX_TRACKED, i·MAX_TRACKED + tracked[i]); column 0 is the edited one.
  const tPost = new Float64Array(PENDING);
  const tReply = new Float64Array(PENDING);
  const tracked = new Int32Array(PENDING);
  /** Columns of the slot not revealed yet; 0 for a free slot. */
  const left = new Int32Array(PENDING);
  const keys = new Float64Array(PENDING * MAX_TRACKED);
  /** Each tracked column's staged time, NaN until staged. */
  const stagedAt = new Float64Array(PENDING * MAX_TRACKED);
  const shown = new Uint8Array(PENDING * MAX_TRACKED);
  let next = 0;
  let active = 0;

  const track = (base: number, j: number, key: number): void => {
    keys[base + j] = key;
    stagedAt[base + j] = Number.NaN;
    shown[base + j] = 0;
  };

  return {
    posted(post, replied, edited, dirty, relightMs, editMs) {
      reply.push(replied - post);
      relight.push(relightMs);
      edit.push(editMs);
      const i = next;
      next = (next + 1) % PENDING;
      // A sample still pending in the slot is dropped.
      if (left[i] === 0) active++;
      const base = i * MAX_TRACKED;
      tPost[i] = post;
      tReply[i] = replied;
      track(base, 0, edited);
      let m = 1;
      for (let k = 0; k < dirty.length && m < MAX_TRACKED; k++) if (dirty[k] !== edited) track(base, m++, dirty[k]!);
      tracked[i] = m;
      left[i] = m;
    },

    staged(cx, cz, t) {
      if (active === 0) return;
      const key = colKey(cx, cz);
      for (let i = 0; i < PENDING; i++) {
        if (left[i] === 0) continue;
        const base = i * MAX_TRACKED;
        for (let j = 0; j < tracked[i]!; j++) {
          // The first payload holding the edit; a later restage (a newer edit's) keeps it.
          if (keys[base + j] === key && shown[base + j] === 0 && Number.isNaN(stagedAt[base + j])) stagedAt[base + j] = t;
        }
      }
    },

    revealed(cx, cz, t) {
      if (active === 0) return;
      const key = colKey(cx, cz);
      for (let i = 0; i < PENDING; i++) {
        if (left[i] === 0) continue;
        const base = i * MAX_TRACKED;
        for (let j = 0; j < tracked[i]!; j++) {
          if (keys[base + j] !== key || shown[base + j] !== 0 || Number.isNaN(stagedAt[base + j])) continue;
          shown[base + j] = 1;
          if (j === 0) {
            visible.push(t - tPost[i]!);
            issueToStaged.push(stagedAt[base]! - tReply[i]!);
            stagedToShown.push(t - stagedAt[base]!);
          }
          left[i] = left[i]! - 1;
          if (left[i] === 0) {
            allVisible.push(t - tPost[i]!);
            active--;
          }
        }
      }
    },

    visibleP95: () => visible.p95(),
    allVisibleP95: () => allVisible.p95(),
    get count() {
      return visible.n;
    },
    samples() {
      return {
        visible: visible.copy(),
        allVisible: allVisible.copy(),
        reply: reply.copy(),
        issueToStaged: issueToStaged.copy(),
        stagedToShown: stagedToShown.copy(),
        relight: relight.copy(),
        edit: edit.copy(),
      };
    },
  };
}
