import type { CapabilityReport, Cause, Evaluation } from '../engine/capabilityRules';

const ROWS: ReadonlyArray<[keyof CapabilityReport, string]> = [
  ['secureContext', 'Secure context'],
  ['pageIsolated', 'Page cross-origin isolated'],
  ['workerProbe', 'Worker probe'],
  ['workerIsolated', 'Worker cross-origin isolated'],
  ['sabShared', 'SharedArrayBuffer shared'],
  ['webgl2', 'WebGL2'],
  ['multiDraw', 'WEBGL_multi_draw'],
  ['timerQuery', 'GPU timer query'],
  ['maxArrayTextureLayers', 'Max array texture layers'],
  ['maxTextureSize', 'Max texture size'],
  ['renderer', 'GPU renderer'],
  ['vendor', 'GPU vendor'],
  ['hardwareConcurrency', 'Logical CPUs'],
  ['deviceMemory', 'Device memory (GB)'],
];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className !== undefined) node.className = className;
  return node;
}

const WARN_ONLY_KEYS: ReadonlySet<keyof CapabilityReport> = new Set(['multiDraw', 'timerQuery']);

function valueClass(key: keyof CapabilityReport, value: CapabilityReport[keyof CapabilityReport]): string {
  if (value === true || value === 'ok') return 'ok';
  if (value === false) return WARN_ONLY_KEYS.has(key) ? 'warn' : 'bad';
  if (value === 'not-isolated' || value === 'load-error' || value === 'timeout') return 'bad';
  return '';
}

function jsonBlock(report: CapabilityReport): HTMLPreElement {
  const pre = el('pre', JSON.stringify(report));
  pre.id = 'capability-json';
  pre.hidden = true;
  return pre;
}

function causeList(causes: readonly Cause[], className: string): HTMLUListElement {
  const ul = el('ul');
  for (const c of causes) ul.append(el('li', c.message, className));
  return ul;
}

/** The capability table, one row per probed value. */
function capabilityTable(report: CapabilityReport): HTMLTableElement {
  const table = el('table', undefined, 'cap-table');
  for (const [key, label] of ROWS) {
    const value = report[key];
    const row = el('tr');
    row.append(el('td', label), el('td', value === null ? '—' : String(value), valueClass(key, value)));
    table.append(row);
  }
  return table;
}

export function renderCapabilityReport(panel: HTMLElement, report: CapabilityReport, evaluation: Evaluation): void {
  const table = capabilityTable(report);
  const copy = el('button', 'Copy as JSON');
  copy.type = 'button';
  copy.onclick = () => {
    navigator.clipboard.writeText(JSON.stringify(report, null, 2)).catch(() => {
      copy.textContent = 'Copy failed';
    });
  };
  panel.replaceChildren(el('h2', 'Capabilities'), table);
  if (evaluation.warnings.length > 0) panel.append(el('h3', 'Warnings'), causeList(evaluation.warnings, 'warn'));
  panel.append(copy, jsonBlock(report));
}

/**
 * The blocking error screen (SP4a spec §8.5): the causes, the capability table, a link to `mapHref` when given (the
 * map needs no SharedArrayBuffer or WebGL2), and the full report.
 */
export function renderErrorScreen(root: HTMLElement, report: CapabilityReport, evaluation: Evaluation, mapHref: string | null = null): void {
  const screen = el('div', undefined, 'error-screen');
  screen.id = 'error-screen';
  screen.append(el('h1', 'world-imaginer-voxel cannot start'), causeList(evaluation.blocking, 'bad'), capabilityTable(report));
  if (mapHref !== null) {
    const map = el('a', 'Open the map instead');
    map.id = 'error-map';
    map.href = mapHref;
    screen.append(map);
  }
  screen.append(
    el('p', 'Fix the causes above and reload. Full report:'),
    el('pre', JSON.stringify(report, null, 2)),
    jsonBlock(report),
  );
  root.replaceChildren(screen);
}
