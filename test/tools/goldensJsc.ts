/**
 * JavaScriptCore check of the SP1 goldens (D20): run with `npx --yes bun@1 test/tools/goldensJsc.ts`
 * (Bun runs JavaScriptCore and resolves the repository's extensionless imports; no dependency is added).
 */
import goldens from '../goldens.json';
import { compareGoldens, computeGolden, goldenKeys } from '../../src/metrics/sp1Goldens';

const expected = (goldens as unknown as { entries: Record<string, string> }).entries;
const rows = compareGoldens(expected, goldenKeys(), computeGolden);
for (const r of rows) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.key} ${r.actual}${r.ok ? '' : ` (expected ${r.expected ?? 'missing'})`}`);
const bad = rows.filter((r) => !r.ok).length;
const bun = (globalThis as { Bun?: { version: string } }).Bun;
console.log(`${rows.length - bad}/${rows.length} match on ${bun !== undefined ? `Bun ${bun.version} (JavaScriptCore)` : `Node ${process.version}`}`);
process.exitCode = bad === 0 ? 0 : 1;
