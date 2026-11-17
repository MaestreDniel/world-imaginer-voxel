/**
 * ?selftest=1 (SP2a spec §6.4): recomputes every golden (SP1, SP2a, SP3a, SP3b, SP3c and SP3e) in one real module worker and
 * compares with the bundled test/goldens.json. A key whose computation throws shows its error, and a job
 * the pool rejects (a failed worker) counts as a failed key, so the summary always completes (SP2a minor 9).
 * A second section, after the goldens, runs the KV contract on `IdbKV` in its own database, `wi10-selftest`, deleted
 * before and after; it never opens `wi10` (SP5b spec §6.4). "copy as JSON" waits for both sections and copies both
 * (`selftestCopyPayload`): the goldens' `results` and the contract's `indexedDb`.
 */
import goldens from '../../../test/goldens.json';
import { createBrowserPool, type WorkerPool } from '../../engine/workerPool';
import { allGoldenKeys } from '../../metrics/sp2aGoldens';
import { deleteIdb, openIdbKV } from '../../persist/idb';
import type { KV } from '../../persist/kv';
import { runKvContract, type KvContractResult } from '../../persist/kvContract';

export interface SelftestRow { readonly key: string; readonly expected: string | null; readonly actual: string | null; readonly error: string | null; readonly ok: boolean }

/** Recomputes `keys` one by one; never rejects: a rejected job becomes a row with error "job failed: …". */
export async function runSelftest(
  pool: Pick<WorkerPool, 'selftest'>, keys: readonly string[], expected: Readonly<Record<string, string>>, onRow: (row: SelftestRow, i: number) => void,
): Promise<SelftestRow[]> {
  const rows: SelftestRow[] = [];
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!;
    let r: { actual: string | null; error: string | null };
    try {
      r = await pool.selftest(key);
    } catch (e) {
      r = { actual: null, error: `job failed: ${e instanceof Error ? e.message : String(e)}` };
    }
    const e = Object.hasOwn(expected, key) ? expected[key]! : null;
    const row: SelftestRow = { key, expected: e, actual: r.actual, error: r.error, ok: r.error === null && r.actual === e };
    rows.push(row);
    onRow(row, i);
  }
  return rows;
}

/** The IndexedDB section's database (SP5b spec §6.4): never `wi10`. */
export const KV_SELFTEST_DB = 'wi10-selftest';

/**
 * Runs `KV_CONTRACT` on `open`'s connections, with `remove` (the database deleted) before and after. Every case closes
 * its connection (`runKvContract`), so the last `remove` never waits on one; it rejects only when a `remove` does.
 */
export async function runKvSelftest(open: () => Promise<KV>, remove: () => Promise<void>): Promise<KvContractResult[]> {
  await remove();
  const results = await runKvContract(open);
  await remove();
  return results;
}

/** The IndexedDB section's outcome: every case's result, or the error that kept the contract from running. */
export type KvSelftestOutcome = { readonly results: readonly KvContractResult[] } | { readonly error: string };

/** "n/m passed" over a contract run's results. */
function kvSummary(results: readonly KvContractResult[]): string {
  return `${results.filter((r) => r.ok).length}/${results.length} passed`;
}

/**
 * Appends `#selftest-kv` ("IndexedDB contract: n/m passed") and each failure's name and error, over `KV_SELFTEST_DB`,
 * and resolves with the outcome it shows; it never rejects.
 */
export async function mountKvSection(
  host: HTMLElement,
  openDb: (name: string) => Promise<KV> = (name) => openIdbKV(name),
  deleteDb: (name: string) => Promise<void> = (name) => deleteIdb(name),
): Promise<KvSelftestOutcome> {
  const line = document.createElement('div');
  line.id = 'selftest-kv';
  line.textContent = 'IndexedDB contract: running…';
  const failures = document.createElement('ul');
  host.append(line, failures);
  try {
    const results = await runKvSelftest(() => openDb(KV_SELFTEST_DB), () => deleteDb(KV_SELFTEST_DB));
    line.textContent = `IndexedDB contract: ${kvSummary(results)}`;
    for (const r of results) {
      if (r.ok) continue;
      const li = document.createElement('li');
      li.textContent = `✗ ${r.name}  error: ${r.error}`;
      failures.append(li);
    }
    return { results };
  } catch (e) {
    const error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    line.textContent = `IndexedDB contract: could not run: ${error}`;
    return { error };
  }
}

/** The object "copy as JSON" copies. */
export interface SelftestCopyPayload {
  readonly userAgent: string;
  readonly results: Record<string, { expected: string | null; actual: string | null; error?: string }>;
  readonly indexedDb:
    | { summary: string; passed: number; total: number; failures: Array<{ name: string; error: string | null }> }
    | { error: string };
}

/**
 * The copied JSON: `userAgent`, `results` (each golden's expected and actual, and its error when it has one) and
 * `indexedDb`, the contract's "n/m passed" with its counts and failures, or the error that kept it from running.
 */
export function selftestCopyPayload(userAgent: string, rows: readonly SelftestRow[], kv: KvSelftestOutcome): SelftestCopyPayload {
  const results = Object.fromEntries(rows.map((r) => [r.key, { expected: r.expected, actual: r.actual, ...(r.error !== null ? { error: r.error } : {}) }]));
  const indexedDb = 'error' in kv
    ? { error: kv.error }
    : {
      summary: kvSummary(kv.results),
      passed: kv.results.filter((r) => r.ok).length,
      total: kv.results.length,
      failures: kv.results.filter((r) => !r.ok).map((r) => ({ name: r.name, error: r.error })),
    };
  return { userAgent, results, indexedDb };
}

export function mountSelftestPage(root: HTMLElement): void {
  const expected = (goldens as unknown as { entries: Record<string, string> }).entries;
  const page = document.createElement('div');
  page.className = 'selftest-page';
  page.style.cssText = 'font: 13px ui-monospace, monospace; color: #ddd; background: #1b1d22; padding: 12px;';
  const title = document.createElement('h2');
  title.textContent = 'world-imaginer-voxel · selftest';
  const summary = document.createElement('div');
  const copy = document.createElement('button');
  copy.textContent = 'copy as JSON';
  copy.disabled = true;
  const list = document.createElement('ul');
  page.append(title, summary, copy, list);
  root.replaceChildren(page);
  const pool = createBrowserPool(1);
  const keys = allGoldenKeys();
  let rows: SelftestRow[] = [];
  let kv: KvSelftestOutcome = { error: 'not run' };
  const t0 = performance.now();
  summary.textContent = `computing 1/${keys.length}…`;
  const onRow = (row: SelftestRow, i: number) => {
    const li = document.createElement('li');
    li.textContent = row.ok ? `✓ ${row.key}` : row.error !== null ? `✗ ${row.key}  error: ${row.error}` : `✗ ${row.key}  expected ${row.expected ?? 'missing'}  got ${row.actual}`;
    list.append(li);
    if (i + 1 < keys.length) summary.textContent = `computing ${i + 2}/${keys.length}…`;
  };
  copy.addEventListener('click', () => {
    navigator.clipboard.writeText(JSON.stringify(selftestCopyPayload(navigator.userAgent, rows, kv), null, 2))
      .then(() => { copy.textContent = 'copied'; }, (e: unknown) => { copy.textContent = `copy failed: ${String(e)}`; });
  });
  void runSelftest(pool, keys, expected, onRow).then((done) => {
    rows = done;
    const bad = rows.filter((r) => !r.ok).length;
    summary.textContent = `${bad === 0 ? `✓ all ${rows.length} goldens match` : `✗ ${bad} of ${rows.length} goldens differ`} (${((performance.now() - t0) / 1000).toFixed(1)} s)`;
    pool.terminate();
    return mountKvSection(page);
  }).then((outcome) => {
    // Enabled only now, so one click always carries the goldens and the IndexedDB contract.
    kv = outcome;
    copy.disabled = false;
  });
}
