/**
 * The pure message handler of a task worker (SP2a spec §5.1): owns one GenContext per configured epoch
 * and answers each validated message. No DOM and no worker globals, so Node tests drive it directly.
 * Tile and spawn jobs stop as soon as the pool's abort cell leaves their epoch and reply ABORTED
 * (SP2b spec §2.2); point and selftest jobs always run to the end.
 */
import { hex64 } from '../core/hash';
import { checkParams } from '../core/params/kit';
import { SCHEMA, type Params } from '../core/params/schema';
import { seedFromInput } from '../core/seed';
import { genKey, stageHashes } from '../core/stage/hash';
import { createGenContext, type GenContext } from '../gen/context';
import { columnPoint } from '../gen/column/columnPoint';
import { findSpawnAbortable } from '../gen/column/spawn';
import { paintTileAbortable } from '../gen/map/tile';
import { computeAnyGolden } from '../metrics/sp2aGoldens';
import { parseToWorker, type ErrorCode, type FromWorker } from './protocol';

const HEX = hex64;
const CHECK = checkParams;
const SCHEMA_ = SCHEMA;
const SEED = seedFromInput;
const GEN_KEY = genKey;
const HASHES = stageHashes;
const CREATE = createGenContext;
const POINT = columnPoint;
const PAINT = paintTileAbortable;
const SPAWN = findSpawnAbortable;
const GOLDEN = computeAnyGolden;
const PARSE = parseToWorker;

export interface Reply {
  readonly msg: FromWorker;
  readonly transfer: readonly ArrayBuffer[];
}

export interface TaskHandler {
  handle(raw: unknown): Reply;
}

const err = (jobId: number | null, epoch: number | null, code: ErrorCode, message: string): Reply => ({ msg: { type: 'error', jobId, epoch, code, message }, transfer: [] });
const NEVER = (): boolean => false;
/** An integer field of a raw message, or null (for the replies to malformed messages). */
const intField = (raw: unknown, key: 'jobId' | 'epoch'): number | null => {
  const v = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>)[key] : undefined;
  return typeof v === 'number' && Number.isInteger(v) ? v : null;
};

export function createTaskHandler(): TaskHandler {
  let epoch = -1;
  let ctx: GenContext | null = null;
  let cell: Int32Array | null = null;
  /** A job of `jobEpoch` stops once the cell holds another epoch; without a cell it never stops. */
  const stopFor = (jobEpoch: number): (() => boolean) => {
    const c = cell;
    return c === null ? NEVER : () => Atomics.load(c, 0) !== jobEpoch;
  };
  return {
    handle(raw) {
      const m = PARSE(raw);
      const jobId = intField(raw, 'jobId');
      const msgEpoch = intField(raw, 'epoch');
      if (m === null) return err(jobId, msgEpoch, 'BAD_MESSAGE', 'malformed message');
      try {
        if (m.type === 'configure') {
          const r = CHECK(SCHEMA_, m.params);
          if (!r.ok) return err(null, m.epoch, 'BAD_PARAMS', r.issues.slice(0, 5).map((i) => `${i.path}: ${i.code}`).join('; '));
          const params: Params = r.value;
          const seed = SEED(m.seedText);
          ctx = CREATE(seed, params);
          epoch = m.epoch;
          cell = m.abort === null ? null : new Int32Array(m.abort);
          const h = HASHES(params);
          const hex: Record<string, string> = {};
          for (const [k, v] of Object.entries(h)) hex[k] = HEX(v);
          return { msg: { type: 'ready', epoch, stageHashes: hex, genKey: HEX(GEN_KEY(seed, h)) }, transfer: [] };
        }
        if (m.type === 'selftest') {
          try {
            return { msg: { type: 'selftestResult', jobId: m.jobId, key: m.key, actual: GOLDEN(m.key), error: null }, transfer: [] };
          } catch (e) {
            return { msg: { type: 'selftestResult', jobId: m.jobId, key: m.key, actual: null, error: e instanceof Error ? e.message : String(e) }, transfer: [] };
          }
        }
        if (ctx === null) return err(m.jobId, m.epoch, 'NOT_CONFIGURED', 'no configure yet');
        if (m.epoch !== epoch) return err(m.jobId, m.epoch, 'STALE_EPOCH', `job epoch ${m.epoch}, worker epoch ${epoch}`);
        const aborted = (): Reply => err(m.jobId, m.epoch, 'ABORTED', `epoch ${m.epoch} was superseded`);
        if (m.type === 'mapTile') {
          const rgba = new ArrayBuffer(256 * 256 * 4);
          const ids = m.layer === 'biome' ? new ArrayBuffer(256 * 256) : null;
          const done = PAINT(ctx, m.layer, m.level, m.tx, m.tz, new Uint8ClampedArray(rgba), stopFor(m.epoch), ids === null ? undefined : new Uint8Array(ids));
          if (done === null) return aborted();
          return ids === null
            ? { msg: { type: 'tile', jobId: m.jobId, epoch, rgba }, transfer: [rgba] }
            : { msg: { type: 'tile', jobId: m.jobId, epoch, rgba, ids }, transfer: [rgba, ids] };
        }
        if (m.type === 'spawn') {
          const spawn = SPAWN(ctx, stopFor(m.epoch));
          return spawn === null ? aborted() : { msg: { type: 'spawnResult', jobId: m.jobId, epoch, spawn }, transfer: [] };
        }
        return { msg: { type: 'pointResult', jobId: m.jobId, epoch, fields: POINT(ctx, m.x, m.z) }, transfer: [] };
      } catch (e) {
        return err(jobId, msgEpoch, 'INTERNAL', e instanceof Error ? e.message : String(e));
      }
    },
  };
}
