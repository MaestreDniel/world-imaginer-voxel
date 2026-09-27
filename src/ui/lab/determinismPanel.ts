import goldens from '../../../test/goldens.json';
import { compareGoldens, computeGolden, goldenKeys, type GoldenRow } from '../../metrics/sp1Goldens';

/** Recomputes every sp1.* golden in this browser, one key per frame, and compares with test/goldens.json. */
export function mountDeterminismPanel(host: HTMLElement): void {
  const expected = (goldens as unknown as { entries: Record<string, string> }).entries;
  const box = document.createElement('div');
  box.className = 'lab-det';
  const title = document.createElement('h3');
  title.textContent = 'Determinism';
  const run = document.createElement('button');
  run.textContent = 'run determinism check';
  const copy = document.createElement('button');
  copy.textContent = 'copy as JSON';
  copy.disabled = true;
  const summary = document.createElement('div');
  const list = document.createElement('ul');
  box.append(title, run, copy, summary, list);
  host.append(box);
  let rows: GoldenRow[] = [];
  run.addEventListener('click', () => {
    rows = [];
    list.replaceChildren();
    copy.disabled = true;
    run.disabled = true;
    const keys = goldenKeys();
    let i = 0;
    const tick = () => {
      if (i >= keys.length) {
        const bad = rows.filter((r) => !r.ok).length;
        summary.textContent = bad === 0 ? `✓ all ${rows.length} goldens match` : `✗ ${bad} of ${rows.length} goldens differ`;
        run.disabled = false;
        copy.disabled = false;
        return;
      }
      const key = keys[i++]!;
      summary.textContent = `computing ${i}/${keys.length}…`;
      const row = compareGoldens(expected, [key], computeGolden)[0]!;
      rows.push(row);
      const li = document.createElement('li');
      li.textContent = row.ok ? `✓ ${key}` : `✗ ${key}  expected ${row.expected ?? 'missing'}  got ${row.actual}`;
      list.append(li);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  copy.addEventListener('click', () => {
    const results = Object.fromEntries(rows.map((r) => [r.key, { expected: r.expected, actual: r.actual }]));
    void navigator.clipboard.writeText(JSON.stringify({ userAgent: navigator.userAgent, results }, null, 2));
  });
}
