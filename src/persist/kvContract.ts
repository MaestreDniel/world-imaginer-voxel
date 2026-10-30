/**
 * The KV contract suite (SP5b spec §6.3, §6.4, D27): the cases every KV adapter passes, run on `MemoryKV` by vitest
 * (`test/unit/kv.test.ts`) and on `IdbKV` in Chrome and Firefox by `?selftest=1`. Framework-free: a case throws an
 * `Error` naming its first mismatch. Each case uses its own world ids (prefixed `kvc-`; a name's 'a' and 'b' stand for
 * the case's two ids) and deletes what it wrote, so the cases share one database.
 */
import { worldRange, type Key, type KV, type ReadRequest, type WriteOp, type WriteResult } from './kv';

export interface KvContractCase {
  readonly name: string;
  run(kv: KV): Promise<void>;
}

export interface KvContractResult {
  name: string;
  ok: boolean;
  error: string | null;
}

/** A readable form of a value for a mismatch message. */
function show(v: unknown): string {
  if (v === undefined) return 'undefined';
  if (v instanceof Uint8Array) return `Uint8Array[${v.join(',')}]`;
  if (typeof v === 'function') return 'a function';
  if (Array.isArray(v)) return `[${v.map(show).join(', ')}]`;
  if (v !== null && typeof v === 'object') {
    return `{${Object.entries(v).map(([k, x]) => `${k}: ${show(x)}`).join(', ')}}`;
  }
  return JSON.stringify(v);
}

/** Structural equality over what the stores hold: primitives, arrays, plain objects and `Uint8Array`s. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    return a instanceof Uint8Array && b instanceof Uint8Array && a.length === b.length && a.every((x, i) => x === b[i]);
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i]));
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

function expectSame(what: string, actual: unknown, expected: unknown): void {
  if (!same(actual, expected)) throw new Error(`${what}: expected ${show(expected)}, got ${show(actual)}`);
}

const COMPLETE: WriteResult = { status: 'complete', errorName: null };

async function write(kv: KV, what: string, ops: readonly WriteOp[]): Promise<void> {
  expectSame(`write (${what})`, await kv.write(ops), COMPLETE);
}

/** Deletes what a case wrote, also when it failed half way; the result is not checked. */
async function cleanUp(kv: KV, ops: readonly WriteOp[]): Promise<void> {
  try {
    await kv.write(ops);
  } catch {
    // write never rejects; a broken adapter's throw must not hide the case's own error.
  }
}

const diffKey = (worldId: string, col: number): Key => [worldId, col];

export const KV_CONTRACT: readonly KvContractCase[] = [
  {
    name: 'put, get, delete',
    async run(kv) {
      const w = 'kvc-pgd';
      const record = { id: w, name: 'A world', seed: [1, 2], backupOf: null };
      const bytes = new Uint8Array([1, 2, 3, 255]);
      try {
        await write(kv, 'put', [
          { op: 'put', store: 'worlds', key: w, value: record },
          { op: 'put', store: 'diffs', key: diffKey(w, 7), value: bytes },
        ]);
        const [got, gotBytes, absent] = await kv.read([
          { op: 'get', store: 'worlds', key: w },
          { op: 'get', store: 'diffs', key: diffKey(w, 7) },
          { op: 'get', store: 'worlds', key: 'kvc-pgd-absent' },
        ]);
        expectSame('get worlds after put', got, record);
        if (!(gotBytes instanceof Uint8Array)) throw new Error(`get diffs after put: expected a Uint8Array, got ${show(gotBytes)}`);
        expectSame('get diffs after put', gotBytes, bytes);
        expectSame('get of an absent key', absent, undefined);
        await write(kv, 'delete', [
          { op: 'delete', store: 'worlds', key: w },
          { op: 'delete', store: 'diffs', key: diffKey(w, 7) },
        ]);
        expectSame('get after delete', await kv.read([
          { op: 'get', store: 'worlds', key: w },
          { op: 'get', store: 'diffs', key: diffKey(w, 7) },
        ]), [undefined, undefined]);
      } finally {
        await cleanUp(kv, [{ op: 'delete', store: 'worlds', key: w }, { op: 'deleteRange', store: 'diffs', range: worldRange(w) }]);
      }
    },
  },
  {
    name: '`getAll` of `worldRange(\'a\')` returns a\'s `diffs` keys only, in colKey order (keys 2^32 − 1, 0, 65536 put in that order come back 0, 65536, 2^32 − 1), not b\'s',
    async run(kv) {
      const a = 'kvc-range-a';
      const b = 'kvc-range-b';
      try {
        await write(kv, 'puts', [
          { op: 'put', store: 'diffs', key: diffKey(a, 2 ** 32 - 1), value: 'a-last' },
          { op: 'put', store: 'diffs', key: diffKey(b, 0), value: 'b-0' },
          { op: 'put', store: 'diffs', key: diffKey(a, 0), value: 'a-0' },
          { op: 'put', store: 'diffs', key: diffKey(a, 65536), value: 'a-65536' },
          { op: 'put', store: 'diffs', key: diffKey(b, 5), value: 'b-5' },
        ]);
        const [all] = await kv.read([{ op: 'getAll', store: 'diffs', range: worldRange(a) }]);
        expectSame('getAll diffs worldRange(a)', all, {
          keys: [diffKey(a, 0), diffKey(a, 65536), diffKey(a, 2 ** 32 - 1)],
          values: ['a-0', 'a-65536', 'a-last'],
        });
      } finally {
        await cleanUp(kv, [{ op: 'deleteRange', store: 'diffs', range: worldRange(a) }, { op: 'deleteRange', store: 'diffs', range: worldRange(b) }]);
      }
    },
  },
  {
    name: 'tuple order: `[\'a\', 4294967295]` < `[\'b\', 0]`; every string key sorts before every tuple key',
    async run(kv) {
      const a = 'kvc-tuple-a';
      const b = 'kvc-tuple-b';
      const s = 'kvc-tuple-s';
      const z = 'kvc-tuple-z';
      try {
        await write(kv, 'puts', [
          { op: 'put', store: 'diffs', key: diffKey(b, 0), value: 'b' },
          { op: 'put', store: 'diffs', key: diffKey(a, 4294967295), value: 'a' },
          { op: 'put', store: 'meta', key: diffKey(s, 0), value: 'tuple' },
          { op: 'put', store: 'meta', key: z, value: 'z' },
          { op: 'put', store: 'meta', key: s, value: 's' },
        ]);
        const [tuples, mixed] = await kv.read([
          { op: 'getAll', store: 'diffs', range: { lower: diffKey(a, 0), upper: diffKey(b, 1) } },
          { op: 'getAll', store: 'meta', range: { lower: s, upper: diffKey(s, 1) } },
        ]);
        expectSame('getAll diffs [a, 0] … [b, 1)', tuples, { keys: [diffKey(a, 4294967295), diffKey(b, 0)], values: ['a', 'b'] });
        expectSame('getAll meta s … [s, 1)', mixed, { keys: [s, z, diffKey(s, 0)], values: ['s', 'z', 'tuple'] });
      } finally {
        await cleanUp(kv, [
          { op: 'deleteRange', store: 'diffs', range: worldRange(a) },
          { op: 'deleteRange', store: 'diffs', range: worldRange(b) },
          { op: 'delete', store: 'meta', key: s },
          { op: 'delete', store: 'meta', key: z },
          { op: 'delete', store: 'meta', key: diffKey(s, 0) },
        ]);
      }
    },
  },
  {
    name: 'atomic abort: a batch whose third op puts a function settles `abort` with `errorName` `\'DataCloneError\'`, and its first two puts are not visible',
    async run(kv) {
      const w = 'kvc-abort';
      try {
        const result = await kv.write([
          { op: 'put', store: 'worlds', key: w, value: { id: w } },
          { op: 'put', store: 'diffs', key: diffKey(w, 1), value: new Uint8Array([1]) },
          { op: 'put', store: 'state', key: w, value: () => 0 },
        ]);
        expectSame('write with an uncloneable third put', result, { status: 'abort', errorName: 'DataCloneError' });
        expectSame('get after the aborted batch', await kv.read([
          { op: 'get', store: 'worlds', key: w },
          { op: 'get', store: 'diffs', key: diffKey(w, 1) },
          { op: 'get', store: 'state', key: w },
        ]), [undefined, undefined, undefined]);
      } finally {
        await cleanUp(kv, [
          { op: 'delete', store: 'worlds', key: w },
          { op: 'deleteRange', store: 'diffs', range: worldRange(w) },
          { op: 'delete', store: 'state', key: w },
        ]);
      }
    },
  },
  {
    name: 'a later put of the same key in one batch wins',
    async run(kv) {
      const w = 'kvc-later';
      try {
        await write(kv, 'two puts of one key', [
          { op: 'put', store: 'state', key: w, value: { worldId: w, flushSeq: 1 } },
          { op: 'put', store: 'state', key: w, value: { worldId: w, flushSeq: 2 } },
        ]);
        expectSame('get after two puts', await kv.read([{ op: 'get', store: 'state', key: w }]), [{ worldId: w, flushSeq: 2 }]);
      } finally {
        await cleanUp(kv, [{ op: 'delete', store: 'state', key: w }]);
      }
    },
  },
  {
    name: 'structured-clone isolation: mutating the value after `put`, or a value `read` returned, changes nothing stored',
    async run(kv) {
      const w = 'kvc-clone';
      const get: ReadRequest = { op: 'get', store: 'history', key: w };
      try {
        const value = { worldId: w, done: [{ edits: [1] }] };
        const written = kv.write([{ op: 'put', store: 'history', key: w, value }]);
        value.done[0]!.edits.push(2);
        value.done.push({ edits: [3] });
        expectSame('write', await written, COMPLETE);
        const [got] = await kv.read([get]);
        expectSame('get after mutating the put value', got, { worldId: w, done: [{ edits: [1] }] });
        (got as { done: unknown[] }).done.length = 0;
        expectSame('get after mutating a read value', await kv.read([get]), [{ worldId: w, done: [{ edits: [1] }] }]);
      } finally {
        await cleanUp(kv, [{ op: 'delete', store: 'history', key: w }]);
      }
    },
  },
  {
    name: '`count` by range',
    async run(kv) {
      const a = 'kvc-count-a';
      const b = 'kvc-count-b';
      try {
        await write(kv, 'puts', [
          { op: 'put', store: 'diffs', key: diffKey(a, 1), value: 1 },
          { op: 'put', store: 'diffs', key: diffKey(a, 2), value: 2 },
          { op: 'put', store: 'diffs', key: diffKey(b, 3), value: 3 },
          { op: 'put', store: 'diffs', key: diffKey(a, 2 ** 32 - 1), value: 4 },
        ]);
        expectSame('count diffs worldRange(a), worldRange(b), an empty world', await kv.read([
          { op: 'count', store: 'diffs', range: worldRange(a) },
          { op: 'count', store: 'diffs', range: worldRange(b) },
          { op: 'count', store: 'diffs', range: worldRange('kvc-count-none') },
        ]), [3, 1, 0]);
      } finally {
        await cleanUp(kv, [{ op: 'deleteRange', store: 'diffs', range: worldRange(a) }, { op: 'deleteRange', store: 'diffs', range: worldRange(b) }]);
      }
    },
  },
  {
    name: '`deleteRange(worldRange(\'a\'))` removes a\'s 3 keys and leaves b\'s 2',
    async run(kv) {
      const a = 'kvc-delrange-a';
      const b = 'kvc-delrange-b';
      try {
        await write(kv, 'puts', [
          { op: 'put', store: 'diffs', key: diffKey(a, 0), value: 'a0' },
          { op: 'put', store: 'diffs', key: diffKey(a, 9), value: 'a9' },
          { op: 'put', store: 'diffs', key: diffKey(a, 2 ** 32 - 1), value: 'a-last' },
          { op: 'put', store: 'diffs', key: diffKey(b, 0), value: 'b0' },
          { op: 'put', store: 'diffs', key: diffKey(b, 9), value: 'b9' },
        ]);
        await write(kv, 'deleteRange', [{ op: 'deleteRange', store: 'diffs', range: worldRange(a) }]);
        const [countA, allB] = await kv.read([
          { op: 'count', store: 'diffs', range: worldRange(a) },
          { op: 'getAll', store: 'diffs', range: worldRange(b) },
        ]);
        expectSame('count diffs worldRange(a) after deleteRange', countA, 0);
        expectSame('getAll diffs worldRange(b) after deleteRange', allB, { keys: [diffKey(b, 0), diffKey(b, 9)], values: ['b0', 'b9'] });
      } finally {
        await cleanUp(kv, [{ op: 'deleteRange', store: 'diffs', range: worldRange(a) }, { op: 'deleteRange', store: 'diffs', range: worldRange(b) }]);
      }
    },
  },
];

/** Runs every case in order, each on a connection of its own from `open` (closed after it); a failure does not stop the rest. */
export async function runKvContract(open: () => Promise<KV>): Promise<KvContractResult[]> {
  const out: KvContractResult[] = [];
  for (const c of KV_CONTRACT) {
    let kv: KV | null = null;
    try {
      kv = await open();
      await c.run(kv);
      out.push({ name: c.name, ok: true, error: null });
    } catch (e) {
      out.push({ name: c.name, ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      kv?.close();
    }
  }
  return out;
}
