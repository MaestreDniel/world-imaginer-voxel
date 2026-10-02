/**
 * ?selftest=1 (SP2a spec §6.4): recomputes every golden (SP1 and SP2a) in one real module worker and
 * compares with the bundled test/goldens.json. A key whose computation throws shows its error, and a job
 * the pool rejects (a failed worker) counts as a failed key, so the summary always completes (SP2a minor 9).
 */
import goldens from '../../../test/goldens.json';
import { createBrowserPool, type WorkerPool } from '../../engine/workerPool';
import { allGoldenKeys } from '../../metrics/sp2aGoldens';

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

export function mountSelftestPage(root: HTMLElement): void {
  const expected = (goldens as unknown as { entries: Record<string, string> }).entries;
  const page = document.createElement('div');
  page.style.cssText = 'font: 13px ui-monospace, monospace; color: #ddd; background: #1b1d22; min-height: 100vh; padding: 12px;';
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
  const t0 = performance.now();
  summary.textContent = `computing 1/${keys.length}…`;
  const onRow = (row: SelftestRow, i: number) => {
    const li = document.createElement('li');
    li.textContent = row.ok ? `✓ ${row.key}` : row.error !== null ? `✗ ${row.key}  error: ${row.error}` : `✗ ${row.key}  expected ${row.expected ?? 'missing'}  got ${row.actual}`;
    list.append(li);
    if (i + 1 < keys.length) summary.textContent = `computing ${i + 2}/${keys.length}…`;
  };
  copy.addEventListener('click', () => {
    const results = Object.fromEntries(rows.map((r) => [r.key, { expected: r.expected, actual: r.actual, ...(r.error !== null ? { error: r.error } : {}) }]));
    navigator.clipboard.writeText(JSON.stringify({ userAgent: navigator.userAgent, results }, null, 2))
      .then(() => { copy.textContent = 'copied'; }, (e: unknown) => { copy.textContent = `copy failed: ${String(e)}`; });
  });
  void runSelftest(pool, keys, expected, onRow).then((done) => {
    rows = done;
    const bad = rows.filter((r) => !r.ok).length;
    summary.textContent = `${bad === 0 ? `✓ all ${rows.length} goldens match` : `✗ ${bad} of ${rows.length} goldens differ`} (${((performance.now() - t0) / 1000).toFixed(1)} s)`;
    copy.disabled = false;
    pool.terminate();
  });
}
