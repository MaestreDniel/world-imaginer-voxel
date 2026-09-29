/**
 * Task-pool protocol (SP2a spec §5.1): plain messages, validated at both ends by hand-written guards.
 * The main thread sends configure / mapTile / point / spawn / selftest; the worker answers ready / tile /
 * pointResult / spawnResult / selftestResult / error. selftest needs no configure.
 */
import { MAP_LEVELS, type MapLevel } from '../core/constants';
import type { StageId } from '../core/ids';
import type { ColumnPoint } from '../gen/column/columnPoint';
import type { Spawn } from '../gen/column/spawn';
import { isLayerId, type LayerId } from '../gen/map/layers';

const LEVELS: readonly number[] = MAP_LEVELS;

export interface ConfigureMsg { readonly type: 'configure'; readonly epoch: number; readonly seedText: string; readonly params: unknown }
export interface MapTileMsg { readonly type: 'mapTile'; readonly jobId: number; readonly epoch: number; readonly layer: LayerId; readonly level: MapLevel; readonly tx: number; readonly tz: number }
export interface PointMsg { readonly type: 'point'; readonly jobId: number; readonly epoch: number; readonly x: number; readonly z: number }
export interface SpawnMsg { readonly type: 'spawn'; readonly jobId: number; readonly epoch: number }
export interface SelftestMsg { readonly type: 'selftest'; readonly jobId: number; readonly key: string }
export type ToWorker = ConfigureMsg | MapTileMsg | PointMsg | SpawnMsg | SelftestMsg;

export interface ReadyMsg { readonly type: 'ready'; readonly epoch: number; readonly stageHashes: Readonly<Partial<Record<StageId, string>>>; readonly genKey: string }
export interface TileMsg { readonly type: 'tile'; readonly jobId: number; readonly epoch: number; readonly rgba: ArrayBuffer }
export interface PointResultMsg { readonly type: 'pointResult'; readonly jobId: number; readonly epoch: number; readonly fields: ColumnPoint }
export type ErrorCode = 'BAD_MESSAGE' | 'BAD_PARAMS' | 'NOT_CONFIGURED' | 'STALE_EPOCH' | 'INTERNAL';
export interface ErrorMsg { readonly type: 'error'; readonly jobId: number | null; readonly code: ErrorCode; readonly message: string }
export interface SpawnResultMsg { readonly type: 'spawnResult'; readonly jobId: number; readonly epoch: number; readonly spawn: Spawn }
/** One recomputed golden: the digest, or the error that stopped it. */
export interface SelftestResultMsg { readonly type: 'selftestResult'; readonly jobId: number; readonly key: string; readonly actual: string | null; readonly error: string | null }
export type FromWorker = ReadyMsg | TileMsg | PointResultMsg | SpawnResultMsg | SelftestResultMsg | ErrorMsg;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
/** Tile coordinates stay inside the colKey window at every level (|tx| · 256 · level ≤ 2^19). */
const tileOk = (t: unknown, level: number): boolean => isInt(t) && Math.abs(t) * 256 * level <= 524288;

/** Validates a message sent to a worker; null when malformed. */
export function parseToWorker(m: unknown): ToWorker | null {
  if (!isObj(m)) return null;
  switch (m['type']) {
    case 'configure':
      return isInt(m['epoch']) && typeof m['seedText'] === 'string' && m['seedText'].trim() !== '' && 'params' in m ? (m as unknown as ConfigureMsg) : null;
    case 'mapTile': {
      const level = m['level'];
      if (!isInt(m['jobId']) || !isInt(m['epoch']) || !isLayerId(m['layer'])) return null;
      if (!isInt(level) || !LEVELS.includes(level) || !tileOk(m['tx'], level) || !tileOk(m['tz'], level)) return null;
      return m as unknown as MapTileMsg;
    }
    case 'point':
      return isInt(m['jobId']) && isInt(m['epoch']) && isFiniteNum(m['x']) && isFiniteNum(m['z']) && Math.abs(m['x']) <= 524288 && Math.abs(m['z']) <= 524288
        ? (m as unknown as PointMsg) : null;
    case 'spawn':
      return isInt(m['jobId']) && isInt(m['epoch']) ? (m as unknown as SpawnMsg) : null;
    case 'selftest':
      return isInt(m['jobId']) && typeof m['key'] === 'string' ? (m as unknown as SelftestMsg) : null;
    default:
      return null;
  }
}

/** Validates a worker reply; null when malformed. */
export function parseFromWorker(m: unknown): FromWorker | null {
  if (!isObj(m)) return null;
  switch (m['type']) {
    case 'ready': return isInt(m['epoch']) && isObj(m['stageHashes']) && typeof m['genKey'] === 'string' ? (m as unknown as ReadyMsg) : null;
    case 'tile': return isInt(m['jobId']) && isInt(m['epoch']) && m['rgba'] instanceof ArrayBuffer && m['rgba'].byteLength === 256 * 256 * 4 ? (m as unknown as TileMsg) : null;
    case 'pointResult': return isInt(m['jobId']) && isInt(m['epoch']) && isObj(m['fields']) ? (m as unknown as PointResultMsg) : null;
    case 'selftestResult': return isInt(m['jobId']) && typeof m['key'] === 'string' && (m['actual'] === null || typeof m['actual'] === 'string') && (m['error'] === null || typeof m['error'] === 'string') ? (m as unknown as SelftestResultMsg) : null;
    case 'spawnResult': return isInt(m['jobId']) && isInt(m['epoch']) && isObj(m['spawn']) ? (m as unknown as SpawnResultMsg) : null;
    case 'error': return (m['jobId'] === null || isInt(m['jobId'])) && typeof m['code'] === 'string' && typeof m['message'] === 'string' ? (m as unknown as ErrorMsg) : null;
    default: return null;
  }
}
