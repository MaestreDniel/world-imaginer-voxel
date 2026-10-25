import { chunkCoord } from '../core/coords';
import { clockHours } from '../daynight/dayNight';
import { bindingLabel, DEFAULT_KEYMAP, type Action } from '../player/keymap';
import type { SectionRendererKind } from '../render/sectionRenderer';
import type { FrameStats, FrameSummary } from './frameStats';

const REFRESH_MS = 250;

/** The fps line (the SP0 HUD's, kept by the world HUD, SP4a spec §6.9). */
export function fpsLine(s: FrameSummary): string {
  return `${s.fps.toFixed(0)} fps · p50 ${s.p50.toFixed(1)} ms · p95 ${s.p95.toFixed(1)} ms`;
}

export function mountHud(host: HTMLElement, stats: FrameStats): () => void {
  const span = document.createElement('span');
  span.className = 'hud';
  host.append(span);
  const id = setInterval(() => {
    span.textContent = fpsLine(stats.summary());
  }, REFRESH_MS);
  return () => clearInterval(id);
}

/** One stage's columns in the current sets (the coordinator's `StageCounts`, SP4b spec §7.3). */
export interface HudStage {
  readonly done: number;
  readonly needed: number;
  readonly inFlight: number;
  readonly queued: number;
}

/**
 * What the world HUD shows (SP4a spec §6.9; SP4b spec §7.3); the page reads it from its pool, coordinator, section
 * renderer, renderer and player, each count straight from its owner (master §4.3: nothing double-counted).
 */
export interface HudData {
  /** The fps line's figures. */
  readonly frame: FrameSummary;
  /** Per stage, in the current sets: done / needed, in flight and queued (the coordinator's counts). */
  readonly stages: { readonly T: HudStage; readonly D: HudStage; readonly L: HudStage; readonly MESH: HudStage };
  /**
   * The MESH-set columns still stale after an Apply (`CoordinatorCounts.stale`, SP4c spec §4.5) and the MESH set's size
   * (`MESH.needed`): the line "stale <stale> / <needed>" shows while `stale` is above 0 (D26).
   */
  readonly stale: number;
  readonly needed: number;
  /** Section meshes uploaded (`SectionRendererCounts.rows`). */
  readonly sections: number;
  /** Columns shown (`SectionRendererCounts.columnsRevealed`). */
  readonly revealed: number;
  /** The throttle's generation cap (SP4b spec §3.8). */
  readonly genCap: number;
  /** Results dropped at intake, and columns skipped after a failed retry (SP4b spec §3.6). */
  readonly dropped: number;
  readonly failed: number;
  /** The last frame's `renderer.info`. */
  readonly drawCalls: number;
  readonly triangles: number;
  /** The camera's absolute block position (the floating origin added back). */
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
  /** Fly speed, blocks/s. */
  readonly speed: number;
  /** Time of day t ∈ [0, 1) (t 0 at sunrise, spec §6.5). */
  readonly time: number;
  /** One of `TIME_SPEEDS`: 1, 10, 60, or 0 for paused. */
  readonly timeSpeed: number;
  /** The render distance set, and the fog's (fractional while a raise eases outward, SP4b spec §5). */
  readonly rdTarget: number;
  readonly rdFog: number;
  /** The pool's size and its live workers. */
  readonly workers: number;
  readonly liveWorkers: number;
  /** Regions holding a staged column or rows to release. */
  readonly regions: number;
  /** The GPU memory estimate, MiB (`WorldRenderer.gpuEstimate`'s parts summed, SP4b spec §8.4). */
  readonly gpuMB: number;
  readonly sectionRenderer: SectionRendererKind;
  /** The renderer string as reported (Firefox masks it, spec §1.5); null when the probe got none. */
  readonly renderer: string | null;
}

/** The clock as HH:MM from t (t 0 is 06:00, the opening t is 08:00). */
export function formatClock(t: number): string {
  // The epsilon keeps 08:00 from reading 07:59 when 24·t lands a hair under the hour.
  const minutes = Math.floor(clockHours(t) * 60 + 1e-6) % 1440;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

/** ×1, ×10, ×60, or paused for 0 (spec §6.5, D16). */
export function timeSpeedLabel(speed: number): string {
  return speed === 0 ? 'paused' : `×${speed}`;
}

function compact(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)} M`;
  if (n >= 1e4) return `${(n / 1e3).toFixed(1)} k`;
  return String(n);
}

/** "H / F1 help · F3 hide": the HUD's key hints, generated from the key map (spec §7.3). */
function keyHints(): string {
  const keys = (a: Action) => (DEFAULT_KEYMAP.find((e) => e.action === a)?.bindings ?? []).map(bindingLabel).join(' / ');
  return `${keys('help')} help · ${keys('hud')} hide`;
}

function hudLines(d: HudData, hints: string): string[] {
  const p = d.position;
  const { T, D, L, MESH } = d.stages;
  const of = (s: HudStage): string => `${s.done}/${s.needed}`;
  const jobs = (s: HudStage): string => `${s.inFlight}/${s.queued}`;
  const lines = [
    fpsLine(d.frame),
    `columns T ${of(T)} · D ${of(D)} · L ${of(L)} · meshed ${of(MESH)} · revealed ${d.revealed} · sections ${d.sections}`,
    `in flight / queued T ${jobs(T)} · D ${jobs(D)} · L ${jobs(L)} · MESH ${jobs(MESH)}`,
  ];
  // While the world regenerates after an Apply (SP4c spec §4.5, D26).
  if (d.stale > 0) lines.push(`stale ${d.stale} / ${d.needed}`);
  lines.push(
    `genCap ${d.genCap} · dropped ${d.dropped} · failed ${d.failed}`,
    `draw calls ${d.drawCalls} · triangles ${compact(d.triangles)}`,
    `x ${p.x.toFixed(1)} y ${p.y.toFixed(1)} z ${p.z.toFixed(1)} · column ${chunkCoord(Math.floor(p.x))}, ${chunkCoord(Math.floor(p.z))}`,
    `speed ${d.speed.toFixed(1)} blocks/s · ${formatClock(d.time)} ${timeSpeedLabel(d.timeSpeed)}`,
    `RD ${d.rdTarget} (fog ${d.rdFog.toFixed(1)}) · workers ${d.liveWorkers}/${d.workers} · ${d.sectionRenderer}`,
    `regions ${d.regions} · GPU ${d.gpuMB.toFixed(1)} MB`,
    `GPU ${d.renderer ?? 'not reported'}`,
    hints,
  );
  return lines;
}

/**
 * The world HUD (SP4a spec §6.9, D30; SP4b spec §7.3): the fps line plus the counts (SP4b: the streaming counts), one
 * line each, refreshed every 250 ms from `read`; SP4c adds "stale n / needed" while the world regenerates (§4.5). The
 * page toggles it on F3 (`toggle`); while hidden it does not read. SP10 grows F3 into the full overlay.
 */
export function mountWorldHud(host: HTMLElement, read: () => HudData): { toggle(): void; dispose(): void } {
  const box = document.createElement('div');
  box.className = 'world-hud';
  const hints = keyHints();
  const rows: HTMLDivElement[] = [];
  const update = (): void => {
    const lines = hudLines(read(), hints);
    while (rows.length < lines.length) {
      const row = document.createElement('div');
      box.append(row);
      rows.push(row);
    }
    // A line that went (the stale count back at 0) takes its row with it.
    while (rows.length > lines.length) rows.pop()!.remove();
    lines.forEach((text, i) => { rows[i]!.textContent = text; });
  };
  host.append(box);
  update();
  const id = setInterval(() => { if (!box.hidden) update(); }, REFRESH_MS);
  return {
    toggle() {
      box.hidden = !box.hidden;
      if (!box.hidden) update();
    },
    dispose() {
      clearInterval(id);
      box.remove();
    },
  };
}
