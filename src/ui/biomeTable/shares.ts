/**
 * The biome share preview (SP2b spec §5.5), a collapsible section over the biome table in the Biomes tab: one
 * bar per surface biome with its share of the §5.5 point stream for the draft, the B1-style warnings (biomes
 * whose bar crosses a limit are marked too) and a totals line (ocean family, ties, outside every box, points).
 * - The shares are requested (`biomeShares` on the pool, model.ts createShareRequests) when the preview driver
 *   settles and when the chart comes on screen while it is settled, so they always run on the draft the map
 *   shows. A hidden tab or panel and a collapsed section request nothing.
 * - The chart is stale (dimmed, with its status) from the next session change, or during a gesture, until a new
 *   result arrives. A cancelled request leaves it stale silently; any other failure also shows a notice.
 */
import './shares.css';
import type { WorldSession } from '../../engine/session';
import type { WorkerPool } from '../../engine/workerPool';
import { SURFACE_BIOMES } from '../../gen/biomes/registry';
import { BIOME_SHARES_POINTS, type BiomeShareSummary } from '../../metrics/biomeShares';
import { el } from '../common/dom';
import type { Notices } from '../common/notice';
import type { PreviewDriver } from '../map/previewDriver';
import { countText, createShareRequests, shareChart, SHARE_LIMITS, sharesStatus, sharesView, swatchColor } from './model';

export interface SharesDeps {
  readonly session: WorldSession;
  readonly notices: Notices;
  /** The pool's statistics jobs (spec §5.4). */
  readonly pool: Pick<WorkerPool, 'stats'>;
  /** The preview driver: the shares are requested when it settles (spec §5.5). */
  readonly driver: Pick<PreviewDriver, 'onSettled' | 'status'>;
  /** Whether the Biomes tab is on screen (shown, with the side panel visible). */
  tabVisible(): boolean;
}

export interface BiomeShares {
  readonly element: HTMLElement;
  /** The tab came on screen: requests the shares if the driver is settled and they are not current. */
  shown(): void;
  /** Stops following the session and the driver (the DOM stays). */
  dispose(): void;
}

interface BarRow {
  readonly row: HTMLElement;
  readonly fill: HTMLElement;
  readonly mark: HTMLElement;
  readonly value: HTMLElement;
}

export function createBiomeShares(host: HTMLElement, deps: SharesDeps): BiomeShares {
  const { session } = deps;
  const element = el('details', 'bs');
  element.open = true;
  const head = el('summary', 'bs-head');
  const status = el('span', 'bs-status');
  head.append(el('span', 'bs-title', 'Biome shares'), status);
  const help = el('p', 'bs-help', `Share of ${countText(BIOME_SHARES_POINTS)} sample points per surface biome with the draft's seed and params, as the map picks them (rivers included). Updated when the preview settles.`);
  const warnings = el('ul', 'bs-warnings');
  const chart = el('div', 'bs-chart');
  const totals = el('div', 'bs-totals');
  element.append(head, help, warnings, chart, totals);

  const markTip = `dominant above ${SHARE_LIMITS.dominant * 100} % (land biomes)`;
  const bars: BarRow[] = SURFACE_BIOMES.map((name, biome) => {
    const row = el('div', 'bs-row');
    row.dataset['biome'] = name;
    const swatch = el('span', 'bs-swatch');
    swatch.style.background = swatchColor(biome);
    const track = el('span', 'bs-track');
    const fill = el('span', 'bs-fill');
    const mark = el('span', 'bs-mark');
    mark.title = markTip;
    track.append(fill, mark);
    const value = el('span', 'bs-value');
    row.append(swatch, el('span', 'bs-name', name), track, value);
    chart.append(row);
    return { row, fill, mark, value };
  });

  /** The result the bars and warnings show (they are rebuilt only when it changes). */
  let drawn: BiomeShareSummary | null = null;
  const draw = (s: BiomeShareSummary) => {
    drawn = s;
    const c = shareChart(s);
    c.bars.forEach((b, i) => {
      const r = bars[i]!;
      r.fill.style.width = `${(b.fraction * 100).toFixed(3)}%`;
      r.mark.hidden = !b.land;
      r.mark.style.left = `${(c.dominantAt * 100).toFixed(3)}%`;
      r.value.textContent = b.text;
      r.row.classList.toggle('bs-warn', b.warning !== null);
      r.row.title = `${b.name} (${b.family}): ${b.text} of the points${b.warning === null ? '' : `, ${b.warning}`}`;
    });
    warnings.replaceChildren(...(c.warnings.length === 0
      ? [el('li', 'bs-ok', 'no warnings (B1 limits)')]
      : c.warnings.map((w) => el('li', 'bs-warning', w.text))));
    totals.textContent = c.totals;
  };

  const render = () => {
    const result = requests.shown;
    const view = sharesView(result?.epoch ?? null, session.state.epoch, session.inGesture);
    element.dataset['state'] = view;
    element.setAttribute('aria-busy', String(requests.pending !== null));
    status.textContent = sharesStatus(view, requests.pending !== null);
    for (const part of [warnings, chart, totals]) part.hidden = result === null;
    if (result !== null && result.summary !== drawn) draw(result.summary);
  };

  const requests = createShareRequests({
    session, pool: deps.pool,
    visible: () => element.open && deps.tabVisible(),
    changed: render,
    failed: (m) => deps.notices.show(`biome shares failed: ${m}`, { kind: 'warn' }),
  });
  const onShown = () => requests.request(deps.driver.status.settled);
  element.addEventListener('toggle', () => { if (element.open) onShown(); });

  const offSession = session.subscribe(() => render());
  // The driver's status still reads unsettled while it runs its onSettled listeners.
  const offSettled = deps.driver.onSettled(() => requests.request(true));
  render();
  host.replaceChildren(element);

  return {
    element,
    shown: onShown,
    dispose() {
      offSession();
      offSettled();
    },
  };
}
