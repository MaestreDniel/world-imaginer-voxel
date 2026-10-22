/**
 * The loading screen (SP4a spec §8.3, D22): the panorama background (`panoramas.ts`), a tip rotating every 7 s from a
 * random start, one thin progress bar with a phase line, and the failure panel (cause, "Copy details", links to the map
 * and to a lower RD). The page computes the fraction (§8.3's stage weights) and the phase; this screen only shows them.
 *
 * The watchdog fires `onWatchdog` after 30 s without a `progress` call that raised the fraction. Time while the tab is
 * hidden does not count: rAF stops in a background tab, so the uploads pause while the workers go on, and a wall clock
 * would fail a load that is fine (Review Focus 2). A `visibilitychange` restarts the window, and so does every check
 * that finds the document hidden, in case the event is missed.
 */
import { el } from '../common/dom';
import { mountBackdrop } from './panoramas';

export interface LoadingScreen {
  /** The load's fraction in [0, 1] (the bar never moves back) and the current phase's name. */
  progress(fraction: number, phase: string): void;
  /** Shows a warning line under the progress (a session's tier-2 notice, ruling P47); the load goes on. */
  warn(text: string): void;
  /** Shows the failure panel and stops the watchdog and the tips. `lowerRd` null hides that link. */
  fail(cause: string, details: string, links: { map: string; lowerRd: string | null }): void;
  /** Fades the screen out over `ms`, then removes it. */
  fadeOut(ms: number): Promise<void>;
  dispose(): void;
}

export interface LoadingScreenOptions {
  readonly tips: string[];
  /** The clock of the watchdog, in ms (`performance.now`). */
  now: () => number;
  readonly doc: Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'>;
  /** Called once, after 30 s of visible time without progress. */
  onWatchdog(): void;
  /** Reads the panorama manifest (ruling P46); a rejection keeps the gradient. */
  loadManifest: () => Promise<unknown>;
  /** Picks the panorama and the first tip, in [0, 1). */
  rand: () => number;
}

/** Spec §8.3: 30 s without progress shows the failure panel. */
export const WATCHDOG_MS = 30_000;
/** Spec §8.3: a tip rotates every 7 s. */
export const TIP_MS = 7_000;
/** How often the watchdog looks at the clock. */
const WATCHDOG_TICK_MS = 500;

export function mountLoadingScreen(root: HTMLElement, o: LoadingScreenOptions): LoadingScreen {
  const screen = el('div', 'loading-screen');
  screen.id = 'loading-screen';
  root.append(screen);
  const backdrop = mountBackdrop(screen, { loadManifest: o.loadManifest, rand: o.rand });

  const front = el('div', 'loading-front');
  const tip = el('p', 'loading-tip');
  tip.id = 'loading-tip';
  const bar = el('div', 'loading-bar');
  const fill = el('div', 'loading-bar-fill');
  fill.id = 'loading-bar-fill';
  fill.style.width = '0%';
  bar.append(fill);
  const phase = el('p', 'loading-phase');
  phase.id = 'loading-phase';
  const warning = el('p', 'loading-warn warn');
  warning.id = 'loading-warn';
  warning.hidden = true;
  front.append(tip, bar, phase, warning);

  // The failure panel, hidden until `fail`.
  const failPanel = el('section', 'loading-fail');
  failPanel.id = 'loading-fail';
  failPanel.hidden = true;
  const cause = el('p', 'loading-cause');
  cause.id = 'loading-cause';
  const details = el('pre', 'loading-details');
  details.id = 'loading-details';
  const copy = el('button', 'loading-copy', 'Copy details');
  copy.id = 'loading-copy';
  copy.type = 'button';
  const mapLink = el('a', 'loading-link', 'Open the map');
  mapLink.id = 'loading-map';
  const lowerRdLink = el('a', 'loading-link', 'Load with a lower render distance');
  lowerRdLink.id = 'loading-lower-rd';
  const links = el('nav', 'loading-links');
  links.append(mapLink, lowerRdLink);
  failPanel.append(el('h2', '', 'The world could not load'), cause, copy, links, details);
  copy.addEventListener('click', () => {
    const fail = () => { copy.textContent = 'Copy failed'; };
    try {
      const clipboard = (globalThis.navigator as Navigator | undefined)?.clipboard;
      if (clipboard === undefined) fail();
      else clipboard.writeText(details.textContent ?? '').then(() => { copy.textContent = 'Copied'; }, fail);
    } catch {
      fail();
    }
  });

  screen.append(front, failPanel);

  // Tips: a random start, then one every 7 s.
  let tipIndex = o.tips.length === 0 ? 0 : Math.min(o.tips.length - 1, Math.max(0, Math.floor(o.rand() * o.tips.length)));
  tip.textContent = o.tips[tipIndex] ?? '';
  let tipTimer: ReturnType<typeof setInterval> | null = o.tips.length > 1
    ? setInterval(() => {
      tipIndex = (tipIndex + 1) % o.tips.length;
      tip.textContent = o.tips[tipIndex]!;
    }, TIP_MS)
    : null;

  // The watchdog: visible time since the last raise of the fraction.
  let best = 0;
  let windowStart = o.now();
  const restart = (): void => { windowStart = o.now(); };
  const onVisibility = (): void => restart();
  o.doc.addEventListener('visibilitychange', onVisibility);
  let watchdog: ReturnType<typeof setInterval> | null = setInterval(() => {
    if (o.doc.hidden) {
      restart();
      return;
    }
    if (o.now() - windowStart >= WATCHDOG_MS) {
      stopTimers();
      o.onWatchdog();
    }
  }, WATCHDOG_TICK_MS);

  let disposed = false;
  function stopTimers(): void {
    if (watchdog !== null) clearInterval(watchdog);
    watchdog = null;
    if (tipTimer !== null) clearInterval(tipTimer);
    tipTimer = null;
    o.doc.removeEventListener('visibilitychange', onVisibility);
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    stopTimers();
    backdrop.dispose();
    screen.remove();
  }

  return {
    progress(fraction, phaseName) {
      const f = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
      if (f > best) {
        best = f;
        restart();
        fill.style.width = `${Math.round(f * 1000) / 10}%`;
      }
      phase.textContent = phaseName;
    },
    warn(text) {
      warning.textContent = text;
      warning.hidden = false;
    },
    fail(causeText, detailText, l) {
      stopTimers();
      cause.textContent = causeText;
      details.textContent = detailText;
      mapLink.href = l.map;
      lowerRdLink.hidden = l.lowerRd === null;
      if (l.lowerRd !== null) lowerRdLink.href = l.lowerRd;
      front.hidden = true;
      failPanel.hidden = false;
    },
    fadeOut(ms) {
      stopTimers();
      screen.style.transition = `opacity ${ms}ms ease`;
      screen.style.opacity = '0';
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          dispose();
          resolve();
        }, ms);
      });
    },
    dispose,
  };
}
