/**
 * The pure message handler of a task worker (SP2a spec §5.1): owns one GenContext per configured epoch
 * and answers each validated message. No DOM and no worker globals, so Node tests drive it directly.
 */
import { hex64 } from '../core/hash';
import { checkParams } from '../core/params/kit';
import { SCHEMA, type Params } from '../core/params/schema';
import { seedFromInput } from '../core/seed';
import { genKey, stageHashes } from '../core/stage/hash';
import { createGenContext, type GenContext } from '../gen/context';
import { columnPoint } from '../gen/column/columnPoint';
import { findSpawn } from '../gen/column/spawn';
import { paintTile } from '../gen/map/tile';
import { parseToWorker, type ErrorCode, type FromWorker } from './protocol';

const HEX = hex64;
const CHECK = checkParams;
const SCHEMA_ = SCHEMA;
const SEED = seedFromInput;
const GEN_KEY = genKey;
const HASHES = stageHashes;
const CREATE = createGenContext;
const POINT = columnPoint;
const PAINT = paintTile;
const SPAWN = findSpawn;
const PARSE = parseToWorker;

export interface Reply {
  readonly msg: FromWorker;
  readonly transfer: readonly ArrayBuffer[];
}

export interface TaskHandler {
  handle(raw: unknown): Reply;
}

const err = (jobId: number | null, code: ErrorCode, message: string): Reply => ({ msg: { type: 'error', jobId, code, message }, transfer: [] });

export function createTaskHandler(): TaskHandler {
  let epoch = -1;
  let ctx: GenContext | null = null;
  return {
    handle(raw) {
      const m = PARSE(raw);
      const jobId = typeof (raw as { jobId?: unknown } | null)?.jobId === 'number' ? (raw as { jobId: number }).jobId : null;
      if (m === null) return err(jobId, 'BAD_MESSAGE', 'malformed message');
      try {
        if (m.type === 'configure') {
          const r = CHECK(SCHEMA_, m.params);
          if (!r.ok) return err(null, 'BAD_PARAMS', r.issues.slice(0, 5).map((i) => `${i.path}: ${i.code}`).join('; '));
          const params: Params = r.value;
          const seed = SEED(m.seedText);
          ctx = CREATE(seed, params);
          epoch = m.epoch;
          const h = HASHES(params);
          const hex: Record<string, string> = {};
          for (const [k, v] of Object.entries(h)) hex[k] = HEX(v);
          return { msg: { type: 'ready', epoch, stageHashes: hex, genKey: HEX(GEN_KEY(seed, h)) }, transfer: [] };
        }
        if (ctx === null) return err(m.jobId, 'NOT_CONFIGURED', 'no configure yet');
        if (m.epoch !== epoch) return err(m.jobId, 'STALE_EPOCH', `job epoch ${m.epoch}, worker epoch ${epoch}`);
        if (m.type === 'mapTile') {
          const rgba = new ArrayBuffer(256 * 256 * 4);
          PAINT(ctx, m.layer, m.level, m.tx, m.tz, new Uint8ClampedArray(rgba));
          return { msg: { type: 'tile', jobId: m.jobId, epoch, rgba }, transfer: [rgba] };
        }
        if (m.type === 'spawn') return { msg: { type: 'spawnResult', jobId: m.jobId, epoch, spawn: SPAWN(ctx) }, transfer: [] };
        return { msg: { type: 'pointResult', jobId: m.jobId, epoch, fields: POINT(ctx, m.x, m.z) }, transfer: [] };
      } catch (e) {
        return err(jobId, 'INTERNAL', e instanceof Error ? e.message : String(e));
      }
    },
  };
}
