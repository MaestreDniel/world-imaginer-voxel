/**
 * ?selftest=1 (SP2a spec §6.4): recomputes every golden (SP1 and SP2a) in one real module worker and
 * compares with the bundled test/goldens.json. A key whose computation throws shows its error.
 */
import goldens from '../../../test/goldens.json';
import { createBrowserPool } from '../../engine/workerPool';
import { allGoldenKeys } from '../../metrics/sp2aGoldens';

interface Row { key: string; expected: string | null; actual: string | null; error: string | null; ok: boolean }

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
  const rows: Row[] = [];
  const t0 = performance.now();
  const next = async (i: number): Promise<void> => {
    if (i >= keys.length) {
      const bad = rows.filter((r) => !r.ok).length;
      summary.textContent = `${bad === 0 ? `✓ all ${rows.length} goldens match` : `✗ ${bad} of ${rows.length} goldens differ`} (${((performance.now() - t0) / 1000).toFixed(1)} s)`;
      copy.disabled = false;
      pool.terminate();
      return;
    }
    const key = keys[i]!;
    summary.textContent = `computing ${i + 1}/${keys.length}…`;
    const r = await pool.selftest(key);
    const e = Object.hasOwn(expected, key) ? expected[key]! : null;
    const row: Row = { key, expected: e, actual: r.actual, error: r.error, ok: r.error === null && r.actual === e };
    rows.push(row);
    const li = document.createElement('li');
    li.textContent = row.ok ? `✓ ${key}` : row.error !== null ? `✗ ${key}  error: ${row.error}` : `✗ ${key}  expected ${e ?? 'missing'}  got ${r.actual}`;
    list.append(li);
    return next(i + 1);
  };
  copy.addEventListener('click', () => {
    const results = Object.fromEntries(rows.map((r) => [r.key, { expected: r.expected, actual: r.actual, ...(r.error !== null ? { error: r.error } : {}) }]));
    navigator.clipboard.writeText(JSON.stringify({ userAgent: navigator.userAgent, results }, null, 2))
      .then(() => { copy.textContent = 'copied'; }, (e: unknown) => { copy.textContent = `copy failed: ${String(e)}`; });
  });
  void next(0);
}
