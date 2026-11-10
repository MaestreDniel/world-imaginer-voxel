/**
 * A saved world opened in process on the real stack (SP5b spec §6.1, `persist.metric.ts`; as `edit.metric.ts`'s E5):
 * the page's open of `/?world=<id>` (§3.4), its edit path, block history, hotbar, places, apply control with the
 * modification mode and its backup, and its autosave, over a `MemoryKV` the caller owns, so E2-E7 save, reload, abort
 * and copy worlds through the code the page runs.
 *
 * - **The open** (§3.4 steps 1-6): `openSavedWorld` (a lock manager that always grants, the KV as the page's connection,
 *   `STATE_BOUNDS`), then the store and the pool (`createWorkerPool(2, inProcessWorker)`), the sim through
 *   `inProcessSimWorker(createSimHandler({ openKV: async () => kv }), delayMs)` attached as thread 15 with the open's
 *   `load` posted right after the attach and awaited with it before the first update, `openOlderGenerator` against the
 *   first configure's genKey, and `restoredStart` (the saved x, z the centre, else the pool's spawn). The real
 *   coordinator, `retainAllProtos`, strict until the first fill and `setStrict(false)` after it, as the page; the sink
 *   takes the payloads and draws nothing.
 * - **After the reveal**, as `run()` wires them: the edit path, `countAccepted`, the block history (restored from the
 *   saved steps) and `createActionPost`; the hotbar over `hotbarStorage`; `createPlaces` over the saved places; the
 *   configure driver (no preview wanted) fed every session change, and the apply control whose `beforeApply` is
 *   `createModifyMode`'s (its checkbox a DOM-shim input, no map tool), whose `onApplied` keeps `appliedRecord`'s record,
 *   sends it with `record` and marks the autosave changed; and `createPageAutosave`, over a pose built from
 *   `restoredStart` (a player left walking walks), its 2,000 ms timer never firing (the metric posts with `flushNow`, as
 *   the hide and close triggers do: at once, without the settled wait), and `revealOlderGenerator`.
 * - **A frame** is the page's: the apply control's tick, one `update` at the centre, the counts and the aux policy with
 *   the map hidden, the store's drain, and one turn of the event loop (`setImmediate`, so no frame waits out a timer's
 *   clamp: the in-process workers answer on their own timers). Every awaiting method runs frames until its promise
 *   settles; any coordinator event or the sim's failure throws, and a frame after `dispose` throws (a loop the metric
 *   left running ends there).
 *
 * The MemoryKV is never closed here (the page's `kv.close()` at its teardown): the page and the sim hold separate
 * connections in a browser, while here both are the caller's one object, which the next open reads again.
 *
 * Beyond the plan's interface (`edit` … `dispose`), the world exposes what the metric reads back: the autosave's
 * `build` (the state and the whole history), the centre column, the store, the block history (E3's undo), the open's
 * older-generator flag, `loaded` reply, D14 notices and frames to the first fill, the kept record, the notices shown,
 * the backups posted, the mode's `beforeApply` (E6's 'L' and 'MESH' cases: no parameter changes those stages alone,
 * `core/stage/registry.ts`), and `settle` and `until` (frames until a promise settles or a condition holds).
 *
 * **The selection tool** (SP5c spec §10.1, `clipboard.metric.ts`): the page's `createSelectTool` and
 * `createSelectActions` over the sim client, the coordinator's gate, the action post and a clipboard store
 * (`createClipboardStore`) whose KV is a second `MemoryKV` (`clipKv`, the caller's when given, so the clipboard outlives
 * `dispose` and reaches a reopen or another world; `crashNext()` on it hits the clipboard's write, never a flush). The
 * harness has no aim and no frame step: a paste or a move is placed with `select.placeAt(x0, y0, z0, true)` and
 * confirmed with `select.confirm()`. The view and the ghost draw nothing; the origin is zero; the body is the pose's.
 * `leave` is the page's leave path (the autosave's `beforeLeave`, then `dispose`); `copy` the sim client's; `teleport`
 * moves the stream camera by whole columns from the pose; `pinned` mirrors the edit path's sim pins on the coordinator
 * (each `simPin` of a column adds 1 to its 3 × 3 until its `simUnpin`), `published` reads the store's column state;
 * `posted` counts the messages posted to the sim by type, `clipboardWrites` the clipboard's KV writes issued. A
 * `delayMs` given the posted message delays its reply by type (a paste's `edits` alone).
 */
import { colKey } from '../../src/core/coords';
import type { ParamsPatch } from '../../src/core/params/schema';
import type { Seed64 } from '../../src/core/hash';
import { createCoordinator, createCoordinatorCounts, worldJobsOf, type StreamCamera, type StreamEvent } from '../../src/engine/coordinator';
import { appliedDraftOf, type WorldStage } from '../../src/engine/invalidation';
import { draftKeyOf } from '../../src/engine/session';
import { createSimClient, type SimClient } from '../../src/engine/simClient';
import { createThrottle } from '../../src/engine/throttle';
import { createWorkerPool } from '../../src/engine/workerPool';
import type { KV } from '../../src/persist/kv';
import { createMemoryKV, type MemoryKV } from '../../src/persist/memory';
import { createSaves, writeRecord, type HistoryRecord, type HistoryWrite, type HotbarRecord, type StateRecord, type WorldRecord } from '../../src/persist/saves';
import type { FlyState } from '../../src/player/fly';
import { createHotbar } from '../../src/player/hotbar';
import { bodyOf, type BodyBox } from '../../src/player/interaction';
import { EYE } from '../../src/player/walk';
import { mergePatch } from '../../src/ui/lab/labState';
import { createPreviewDriver, createReplayingCanvas, draftOf, type DriverClock } from '../../src/ui/map/previewDriver';
import { createApplyControl, createEpochs, updateAuxPolicy } from '../../src/ui/world/applyControl';
import { createActionPost, createBlockHistory, type BlockHistory } from '../../src/ui/world/blockHistory';
import { createEditLatency } from '../../src/ui/world/editLatency';
import { createClipboardStore } from '../../src/ui/world/clipboardStore';
import { createEditPath, type EditOutcome } from '../../src/ui/world/editPath';
import { createModifyMode, createModifySwitch } from '../../src/ui/world/modifyMode';
import { createPlaces } from '../../src/ui/world/places';
import type { Box } from '../../src/ui/world/pasteBatch';
import { parseWorldQuery } from '../../src/ui/world/query';
import { createSelectTool, type SelectTool } from '../../src/ui/world/selectTool';
import { STATE_BOUNDS } from '../../src/ui/world/stateBounds';
import type { LockManagerLike } from '../../src/ui/world/worldLock';
import {
  appliedRecord, countAccepted, createPageAutosave, createSelectActions, hotbarStorage, NO_GHOST, openOlderGenerator,
  openSavedWorld, pageKeyName, restoredStart, revealOlderGenerator, SAVES_DB, type SelectActions,
} from '../../src/ui/world/worldPage';
import type { BackedUpMsg, CopiedMsg, Edit, FlushedMsg, LoadedMsg } from '../../src/workers/protocol';
import { createSimHandler } from '../../src/workers/simHandler';
import { createStore, type VoxelStore } from '../../src/world/store/store';
import { installDom } from '../unit/fixtures/domShim';
import { inProcessWorker } from './inProcessPool';
import { inProcessSimWorker } from './inProcessSim';
import { litRegionHash } from './region';

const MiB = 1 << 20;
/**
 * A step that has not settled after this many frames, and after `STALL_MS` at least, is a stall. The time floor keeps a
 * reply delayed on purpose (SP5c's leave and Review Focus 1: 1,500 ms) from counting as one on a fast machine, where
 * an idle frame takes a few tens of microseconds.
 */
const FRAMES_MAX = 50_000;
const STALL_MS = 10_000;

export interface PersistWorld {
  /** Posts a batch through the page's action post (recorded in the block history when accepted); frames until its outcome. */
  edit(edits: readonly Edit[]): Promise<EditOutcome>;
  /** The autosave's `flushNow` (posted at once); frames until its `flushed`. */
  flushNow(): Promise<FlushedMsg>;
  /** `litRegionHash` of the (2r + 1)² columns centred on the centre column. */
  windowHash(r: number): string;
  /** The state record the autosave would post now. */
  state(): StateRecord;
  /**
   * The state and the whole history the autosave would post now (its `build`, the backup's): `write` as posted (every
   * step with its id, SP5c spec §5), `history` the same as one record.
   */
  build(): { readonly state: StateRecord; readonly history: HistoryRecord; readonly write: HistoryWrite };
  /** Switches the modification mode (its checkbox's path). */
  modify(on: boolean): void;
  /**
   * Changes the draft by `patch` (the session's `load` over the current patch; nothing when the mode refuses it), then
   * frames until the apply control applied or adopted it and the world settled: `from` the Apply's stage (null for an
   * adopt or no change), `backedUp` whether a backup copy was posted during it and committed. With
   * `revertBeforeCommit`, the draft returns to the applied one as soon as the copy is posted (D11's adopt). With
   * `offBeforeApply`, the mode is switched off right after the change is made, before any frame (D10: an edit already
   * made still applies). With `noWait`, it returns once the Apply has started (the backup, if any, committed before
   * it), the world still regenerating (`atApplied()` false until it settles).
   */
  change(patch: ParamsPatch, o?: { revertBeforeCommit?: boolean; offBeforeApply?: boolean; noWait?: boolean }): Promise<{ from: WorldStage | null; backedUp: boolean }>;
  /** The page's `record`: sent to the sim, counted as a change for the next flush. */
  record(world: WorldRecord): void;
  readonly kv: MemoryKV;
  readonly simClient: SimClient;
  /** Tears the session down as the page does (the lock last); the KV stays open. */
  dispose(): void;
  /** The page's leave (SP5c spec §2.8): the autosave's `beforeLeave` (frames until it resolves), then `dispose`. */
  leave(): Promise<FlushedMsg | null>;

  // The selection tool (SP5c spec §10.1; see the module comment).
  readonly tool: SelectTool;
  readonly select: SelectActions;
  /** The clipboard's KV (the caller's `clipKv`, else one of this world's own). */
  readonly clipKv: MemoryKV;
  /** The clipboard's KV writes issued so far (each `write` call, settled or not). */
  readonly clipboardWrites: number;
  /** The sim client's `copy`; frames until its reply. */
  copy(box: Box, gen: boolean): Promise<CopiedMsg>;
  /** Moves the stream camera to the pose moved by (dcx, dcz) columns; (0, 0) is the pose. */
  teleport(dcx: number, dcz: number): void;
  /** Whether a pending edit pins (cx, cz): a `simPin` of a column within one of it not yet `simUnpin`ned. */
  pinned(cx: number, cz: number): boolean;
  /** Whether the store holds (cx, cz) Published (its own record). */
  published(cx: number, cz: number): boolean;
  /** The coordinator's edit gate for (cx, cz)'s 3 × 3 (`editState`: 0 open, 1 not loaded, 2 regenerating). */
  editState(cx: number, cz: number): 0 | 1 | 2;
  /** The messages of `type` posted to the sim so far. */
  posted(type: string): number;
  /** The coordinator's first fill of the current disc (`firstFill`). */
  filled(): boolean;
  /** The applied epoch reached: no stale column, every one meshed (`change`'s settled test). */
  atApplied(): boolean;
  /** Whether the edit path has a bulk batch posted and not answered. */
  bulkPending(): boolean;

  // Read back by the metric (see the module comment).
  readonly centre: { readonly cx: number; readonly cz: number };
  readonly store: VoxelStore;
  readonly history: BlockHistory;
  /** The open's older-generator flag (D8), its `loaded` reply and the D14 notices it read. */
  readonly opened: { readonly older: boolean; readonly loaded: LoadedMsg; readonly notices: readonly string[]; readonly fillFrames: number };
  /** The record the page keeps (§3.6). */
  kept(): WorldRecord;
  /** Every notice shown, in order. */
  readonly notices: readonly string[];
  /** Every backup posted, with its outcome once settled. */
  readonly backups: ReadonlyArray<{ readonly name: string; readonly done: Promise<BackedUpMsg> }>;
  /** The apply control's `beforeApply`, the modification mode's. */
  beforeApply(from: WorldStage | null): boolean;
  /** Frames until `p` settles; its value. */
  settle<T>(p: Promise<T>, what: string): Promise<T>;
  /** Frames until `done()`. */
  until(done: () => boolean, what: string): Promise<void>;
}

/** A lock manager that grants every request at once (one tab). */
const FREE_LOCKS: LockManagerLike = {
  request: (_name, _o, cb) => Promise.resolve(cb({})),
};

/** The driver's clock on real time (the watchdog's timers by id). */
function realClock(): DriverClock & { clearAll(): void } {
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  let next = 1;
  return {
    now: () => performance.now(),
    setTimeout(fn, ms) {
      const id = next++;
      timers.set(id, setTimeout(() => { timers.delete(id); fn(); }, ms));
      return id;
    },
    clearTimeout(id) {
      const t = timers.get(id);
      if (t !== undefined) clearTimeout(t);
      timers.delete(id);
    },
    clearAll() {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    },
  };
}

const turn = (): Promise<void> => new Promise((r) => setImmediate(r));
/** The session's random seed for an empty seed text, which a saved record never has (tests never use `Math.random`). */
const randomSeed = (): Seed64 => [1, 2];

export async function openPersistWorld(o: {
  kv: MemoryKV; worldId: string; rd: number;
  /** Each posted message's reply delay, ms, read at its post (none: 0). */
  delayMs?: (msg: unknown) => number;
  /** The clipboard's KV (SP5c): passed again to each reopen and to another world, so the clipboard outlives `dispose`. */
  clipKv?: MemoryKV;
}): Promise<PersistWorld> {
  const { kv, worldId, rd } = o;
  if (typeof (globalThis as { document?: unknown }).document === 'undefined') installDom();
  const teardown: Array<() => void> = [];
  let disposed = false;
  const dispose = (): void => {
    disposed = true;
    for (const f of teardown.splice(0).reverse()) f();
  };
  try {
    // §3.4 steps 1-2: the lock, the records, the session from the record (the modification mode off).
    const r = await openSavedWorld({ locks: FREE_LOCKS, open: async () => kv, db: SAVES_DB, id: worldId, bounds: STATE_BOUNDS, random: randomSeed });
    if (!r.ok) throw new Error(`openPersistWorld: ${worldId} refused: ${JSON.stringify(r.refusal)}`);
    const opened = r.opened;
    teardown.push(() => opened.lock.release());
    const session = opened.session;

    // 3. The store, the pool and the sim; `load` right after the attach, awaited with it before the first update.
    const store = createStore({ shared: true, maxBlockBytes: 256 * MiB, maxByteBytes: 256 * MiB });
    const pool = createWorkerPool(2, inProcessWorker, { epochCells: store.epochs.cells, onWorkerDead: (t) => store.markDead(t) });
    teardown.push(() => pool.terminate());
    let simFailure: Error | null = null;
    const delay = o.delayMs ?? (() => 0);
    // The messages posted by type; each message's delay read at its post, from the message (a paste's `edits` alone).
    const postedByType = new Map<string, number>();
    const spawnSim = () => {
      let next = 0;
      const w = inProcessSimWorker(createSimHandler({ openKV: async () => kv }), () => next);
      const post = w.postMessage.bind(w);
      w.postMessage = (m, transfer) => {
        const type = String((m as { type?: unknown }).type);
        postedByType.set(type, (postedByType.get(type) ?? 0) + 1);
        next = delay(m);
        post(m, transfer);
      };
      return w;
    };
    const sim = createSimClient(spawnSim, { onFailure(e) { simFailure = e; } });
    teardown.push(() => sim.dispose());
    await pool.attachStore(store.handles());
    const attaching = sim.attach(store.handles());
    const loading = sim.load(opened.load);
    const firstReady = await pool.configure(session.state.seedText, session.state.params);
    if (firstReady.type !== 'ready') throw new Error(`openPersistWorld: the first configure answered ${firstReady.type}`);
    const [, loaded] = await Promise.all([attaching, loading]);
    // 4. An older generator's record goes to the sim once its diffs are loaded.
    const generator = openOlderGenerator({ kept: opened.kept, readyGenKey: firstReady.genKey, sim });

    // 5. The saved pose, mode, speed and time (or the spawn search for a new world's first Play).
    const start = restoredStart(opened.state, parseWorldQuery(new URLSearchParams(`world=${worldId}`)), null);
    const at = start.centre ?? await pool.spawn();
    const centre = { cx: Math.floor(at.x / 16), cz: Math.floor(at.z / 16) };
    let cam: StreamCamera = { x: at.x, z: at.z, yawDeg: 0 };
    const events: StreamEvent[] = [];
    const epochs = createEpochs();
    const coordinator = createCoordinator({
      jobs: worldJobsOf(pool, sim),
      store,
      // The sink takes the payloads and draws nothing: the metric reads the store.
      sink: { stage() {}, unstage: () => false, remove() {} },
      throttle: createThrottle({ max: Math.max(1, pool.size - 1) }),
      rd,
      rdMax: rd,
      retainAllProtos: true,
      strict: true,
      generation: pool.epoch,
      epoch: epochs.of(firstReady.genKey),
      onEvent: (e) => { events.push(e); },
    });
    teardown.push(() => coordinator.dispose());
    const counts = createCoordinatorCounts();
    let control: { tick(): void; readonly generation: number } | null = null;

    const frame = async (): Promise<void> => {
      // A frame loop still running when the world is torn down (a flush the metric left in flight) ends here.
      if (disposed) throw new Error('persistWorld: disposed');
      control?.tick();
      coordinator.update(cam);
      coordinator.counts(counts);
      if (control !== null) updateAuxPolicy(pool, control.generation, false, counts, coordinator.regenerating);
      store.drain();
      await turn();
      const e = events[0];
      if (e !== undefined) throw new Error(`persistWorld: ${e.kind === 'fatal' ? `fatal: ${e.message}` : e.kind === 'skipped' ? `skipped (${e.cx}, ${e.cz})` : `storeFull (lower to ${e.lowerRd})`}`);
      if (simFailure !== null) throw new Error(`persistWorld: the sim failed: ${(simFailure as Error).message}`);
    };
    let frames = 0;
    const until = async (done: () => boolean, what: string): Promise<void> => {
      const t0 = performance.now();
      for (let i = 0; i < FRAMES_MAX || performance.now() - t0 < STALL_MS; i++) {
        await frame();
        frames++;
        if (done()) return;
      }
      throw new Error(`persistWorld: ${what}: not settled after ${FRAMES_MAX} frames and ${STALL_MS / 1000} s`);
    };
    const settle = async <T>(p: Promise<T>, what: string): Promise<T> => {
      let done = false;
      void p.then(() => { done = true; }, () => { done = true; });
      await until(() => done, what);
      return p;
    };

    await until(() => coordinator.firstFill(), 'the first fill');
    const fillFrames = frames;
    coordinator.setStrict(false);

    // After the reveal (`run()`'s order): notices, the edit path, the block history, the hotbar and the places.
    const notices: string[] = [...opened.notices];
    if (loaded.skippedColumns > 0) notices.push(`${loaded.skippedColumns} columns of this world could not be read`);
    if (loaded.unknownStates > 0) notices.push(`${loaded.unknownStates} blocks of unknown types became air`);
    const show = { show: (text: string) => { notices.push(text); }, hide: () => {} };
    // The edit path's sim pins, mirrored as the coordinator counts them (each on the pinned column's 3 × 3).
    const simPins = new Map<number, number>();
    const pinBy = (cx: number, cz: number, d: number): void => {
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const k = colKey(cx + dx, cz + dz);
          const n = Math.max(0, (simPins.get(k) ?? 0) + d);
          if (n === 0) simPins.delete(k);
          else simPins.set(k, n);
        }
      }
    };
    const gate = {
      editState: (cx: number, cz: number) => coordinator.editState(cx, cz),
      simPin(cx: number, cz: number) {
        pinBy(cx, cz, 1);
        coordinator.simPin(cx, cz);
      },
      simUnpin(cx: number, cz: number) {
        pinBy(cx, cz, -1);
        coordinator.simUnpin(cx, cz);
      },
      markEdited: (keys: ArrayLike<number>) => coordinator.markEdited(keys),
    };
    const editPath = createEditPath({ sim, coordinator: gate, latency: createEditLatency(), now: () => performance.now(), notices: show });
    const accepted = countAccepted(editPath.post);
    const history = createBlockHistory({
      post: accepted.post,
      read: (x, y, z) => {
        store.enterRead();
        try {
          return ((store.blockAt(x, y, z) << 8) | store.fluidAt(x, y, z)) >>> 0;
        } finally {
          store.exitRead();
        }
      },
      pending: editPath.pending,
      settled: editPath.settled,
      notices: show,
    });
    // The saved steps, remapped at the read (§3.4 step 6).
    history.restore(opened.history.done, opened.history.undone);
    const actionPost = createActionPost({ post: accepted.post, record: history.record });
    // The hotbar reads the world's record through its storage adapter, as the page's (§3.4 step 6).
    let worldHotbar: HotbarRecord = opened.state.hotbar;
    createHotbar(hotbarStorage(() => worldHotbar, (h) => { worldHotbar = h; }));
    const places = createPlaces(opened.state.places, () => crypto.randomUUID());

    // The pose: the saved one, or the spawn's surface for a new world's first Play.
    const surfaceY = (): number => {
      store.enterRead();
      try {
        return (store.heightAt('worldSurface', Math.floor(at.x), Math.floor(at.z)) ?? 64) + EYE;
      } finally {
        store.exitRead();
      }
    };
    const fly: FlyState = {
      x: at.x, y: start.view.y ?? surfaceY(), z: at.z, yaw: start.view.yaw ?? 0, pitch: start.view.pitch ?? 0,
      vx: 0, vy: 0, vz: 0, speed: start.speed, mode: start.walk ? 'walk' : 'fly',
    };
    const frameT = { t: start.t };

    // The configure driver and the apply control (SP4c spec §4.2-§4.3), the mode's `beforeApply` (§3.6).
    const clock = realClock();
    teardown.push(() => clock.clearAll());
    const driver = createPreviewDriver(pool, createReplayingCanvas(), clock, { spawnPriority: 600 });
    teardown.push(() => driver.dispose());
    driver.setPreviewWanted(false);
    driver.adopt({ poolEpoch: pool.epoch, sessionEpoch: session.state.epoch, seedKey: draftOf(session.state).seedKey, ready: firstReady });
    teardown.push(session.subscribe((s, change) => driver.change(draftOf(s), change, clock.now())));
    let kept = generator.kept;
    let appliedSnapshot = session.snapshot;
    let appliedCount = 0;
    let lastFrom: WorldStage | null = null;
    const backups: Array<{ name: string; done: Promise<BackedUpMsg> }> = [];
    let autosaveRef: ReturnType<typeof createPageAutosave> | null = null;
    const modifySwitch = createModifySwitch();
    const mode = createModifyMode({
      session,
      tool: () => null,
      checkbox: modifySwitch.checkbox,
      backup: {
        sim: {
          backup: (m) => {
            const done = sim.backup(m);
            backups.push({ name: m.newWorld.name, done });
            return done;
          },
          hasAnyEntries: () => sim.hasAnyEntries(),
        },
        kept: () => kept,
        applied: () => appliedSnapshot,
        build: () => autosaveRef!.build(),
        newId: () => crypto.randomUUID(),
        names: () => createSaves(kv).list().then((rows) => rows.flatMap((row) => (row.broken ? [] : [row.world.name]))),
        notices: show,
      },
    });
    teardown.push(() => mode.dispose());
    const applyControl = createApplyControl({
      coordinator,
      driver,
      session,
      pool,
      clock,
      epochs,
      initial: appliedDraftOf(draftOf(session.state).seedKey, firstReady),
      initialGeneration: pool.epoch,
      beforeApply: (from) => mode.beforeApply(from),
      onApplied: ({ from }) => {
        kept = appliedRecord(kept, session.state, applyControl.applied.genKey);
        appliedSnapshot = session.snapshot;
        sim.record(kept);
        autosaveRef?.markChanged();
        appliedCount++;
        lastFrom = from;
      },
    });
    teardown.push(() => applyControl.dispose());
    control = applyControl;

    // The autosave (§3.2), armed with the world as opened; its timer never fires (module comment).
    const autosave = createPageAutosave({
      worldId,
      fly,
      frame: frameT,
      speedIndex: () => start.speedIndex,
      storedTime: null,
      hotbar: () => worldHotbar,
      places: () => places.list,
      blockHistory: history,
      historyIds: opened.historyIds,
      sim,
      settled: editPath.settled,
      bulkPending: editPath.bulkPending,
      pending: editPath.pending,
      editsSince: accepted.count,
      now: () => Date.now(),
      clock: {
        now: () => performance.now(),
        setInterval: () => 0,
        clearInterval: () => {},
        setTimeout: (f, ms) => setTimeout(f, ms) as unknown as number,
        clearTimeout: (id) => clearTimeout(id),
      },
      events: { on: () => () => {}, hidden: () => false },
      // The page's storage notices (D14) are not read here: `flushNow` returns each outcome.
      onResult: () => {},
    });
    autosaveRef = autosave;
    teardown.push(() => autosave.dispose());
    revealOlderGenerator(generator, { notices: show, autosave });
    teardown.push(places.subscribe(() => autosave.markChanged()));

    // The selection tool (SP5c spec §1-§2), as the page wires it, over the clipboard's own KV (module comment).
    const clipKv = o.clipKv ?? createMemoryKV();
    let clipboardWrites = 0;
    const clipView: KV = {
      read: (reqs) => clipKv.read(reqs),
      write: (ops) => {
        clipboardWrites++;
        return clipKv.write(ops);
      },
      onEvent: (f) => clipKv.onEvent(f),
      // The page closes only a connection the clipboard opened itself; this one outlives the world.
      close() {},
    };
    const tool = createSelectTool();
    const body: BodyBox = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
    const select = createSelectActions({
      tool,
      sim,
      editState: (cx, cz) => coordinator.editState(cx, cz),
      clipboard: createClipboardStore({ kv: async () => clipView, notices: { show: (text) => { notices.push(text); } } }),
      actionPost: (edits) => actionPost(edits),
      notices: { show: (text) => { notices.push(text); } },
      keyName: pageKeyName,
      view: { setSelectionBox() {}, hideSelectionBox() {}, setSelectLabel() {} },
      ghost: NO_GHOST,
      origin: { x: 0, y: 0, z: 0 },
      body: () => bodyOf('fly', fly.x, fly.y, fly.z, body),
      stopRepeat: () => {},
    });
    teardown.push(() => select.dispose());

    /** The applied epoch reached: no stale MESH-set column, every one meshed. */
    const settledAtApplied = (): boolean => {
      coordinator.counts(counts);
      return counts.epoch === epochs.of(applyControl.applied.genKey) && counts.stale === 0 && coordinator.firstFill();
    };

    const world: PersistWorld = {
      async edit(edits) {
        const out = await settle(actionPost(edits), 'an edit');
        await until(() => !editPath.pending(), 'the edit path');
        return out;
      },
      async flushNow() {
        const res = await settle(autosave.flushNow(), 'a flush');
        if (res === null) throw new Error('persistWorld: flushNow: the sim is gone');
        return res;
      },
      windowHash(radius) {
        store.enterRead();
        try {
          return litRegionHash(store, centre.cx - radius, centre.cz - radius, 2 * radius + 1, 2 * radius + 1);
        } finally {
          store.exitRead();
        }
      },
      state: () => autosave.build().state,
      build() {
        const b = autosave.build();
        return { state: b.state, history: writeRecord(b.history), write: b.history };
      },
      modify: (on) => mode.set(on),
      async change(patch, opts) {
        const before = session.snapshot;
        const res = session.load({ profile: before.profile, patch: mergePatch(before.patch, patch) });
        if (!res.ok) throw new Error(`persistWorld: change: ${res.issues[0]?.message ?? 'refused'}`);
        if (opts?.offBeforeApply === true) mode.set(false);
        if (draftKeyOf(session.snapshot) === draftKeyOf(before)) return { from: null, backedUp: false };
        const n = appliedCount;
        const b0 = backups.length;
        let reverted = false;
        await until(() => {
          if (opts?.revertBeforeCommit === true && !reverted && backups.length > b0) {
            reverted = true;
            session.load(appliedSnapshot);
          }
          return appliedCount > n;
        }, 'the change applied');
        const posted = backups.slice(b0);
        // The Apply has started: a backup it waited for has committed, so its outcome is at hand without a frame.
        if (opts?.noWait === true) {
          const done = await Promise.all(posted.map((b) => b.done));
          return { from: lastFrom, backedUp: done.some((x) => x.ok) };
        }
        const outcomes = await settle(Promise.all(posted.map((b) => b.done)), 'the backup');
        await until(settledAtApplied, 'the world settled after the change');
        return { from: lastFrom, backedUp: outcomes.some((x) => x.ok) };
      },
      record(w) {
        sim.record(w);
        autosave.markChanged();
      },
      kv,
      simClient: sim,
      dispose,
      async leave() {
        const r = await settle(autosave.beforeLeave(), 'the leave');
        dispose();
        return r;
      },
      tool,
      select,
      clipKv,
      get clipboardWrites() {
        return clipboardWrites;
      },
      copy: (box, gen) => settle(sim.copy(box, gen), 'a copy'),
      teleport(dcx, dcz) {
        cam = { x: at.x + 16 * dcx, z: at.z + 16 * dcz, yawDeg: 0 };
      },
      pinned: (cx, cz) => (simPins.get(colKey(cx, cz)) ?? 0) > 0,
      editState: (cx, cz) => coordinator.editState(cx, cz),
      published(cx, cz) {
        if (store.holder(cx, cz) !== 'self') return false;
        store.enterRead();
        try {
          return store.publishedAt(16 * cx, 16 * cz);
        } finally {
          store.exitRead();
        }
      },
      posted: (type) => postedByType.get(type) ?? 0,
      filled: () => coordinator.firstFill(),
      atApplied: settledAtApplied,
      bulkPending: () => editPath.bulkPending(),
      centre,
      store,
      history,
      opened: { older: generator.older, loaded, notices: opened.notices, fillFrames },
      kept: () => kept,
      notices,
      backups,
      beforeApply: (from) => mode.beforeApply(from),
      settle,
      until,
    };
    return world;
  } catch (e) {
    dispose();
    throw e;
  }
}

